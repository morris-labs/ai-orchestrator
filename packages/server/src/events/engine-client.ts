// The server's client for one project container's engine: typed calls to the
// engine API, a health check with the version check, and a subscription to
// the engine's event socket that relays events and answers lease requests.
import {
  ApiErrorSchema,
  ClientHelloSchema,
  EngineHealthSchema,
  EngineStreamFrameSchema,
  LeaseResponseFrameSchema,
  buildPath,
  engineRoutes,
  type AgentBoxEvent,
  type EngineInfo,
  type EngineRouteKey,
  type LeaseRequest,
  type LeaseResponse,
  type PathParams,
} from "@agentbox/contracts";
import WebSocket from "ws";
import type { z } from "zod";
import { ApiError } from "../api/errors.js";
import type { EngineEndpoint } from "../api/core-interface.js";

export type EngineHealth = z.infer<typeof EngineHealthSchema>;

/** Where the client keeps the engine stream position, so a reconnect replays. */
export interface StreamCursor {
  get(): { streamId: string; lastSeq: number } | null;
  set(streamId: string, lastSeq: number): void;
}

export interface EngineClientOptions {
  endpoint: EngineEndpoint;
  /** The engine version this server expects. */
  expectedVersion: string;
  cursor: StreamCursor;
  /** Receives each engine event, in order. */
  onEvent(event: AgentBoxEvent): void;
  /** Answers a lease request. */
  onLease(request: LeaseRequest): Promise<LeaseResponse>;
  /** Called when the engine's stream id changed, so missed events can't replay. */
  onResync?(): void;
  /** Called whenever the engine's health or connection state changes. */
  onInfo?(info: EngineInfo): void;
  log?(message: string): void;
  fetch?: typeof fetch;
  /** Reconnect delays; the last one repeats. */
  backoffMs?: number[];
  /** Per-request timeout for REST calls. */
  timeoutMs?: number;
}

/** Input of an engine call; `params` fill the path. */
export interface EngineCallInput {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 5000, 10_000, 30_000];

export class EngineClient {
  private ws: WebSocket | null = null;
  /** Sockets closed after a failed relay; their remaining event frames are dropped. */
  private readonly broken = new WeakSet<WebSocket>();
  private stopped = true;
  private attempt = 0;
  private timer: NodeJS.Timeout | null = null;
  private engineInfo: EngineInfo;

  constructor(private readonly options: EngineClientOptions) {
    this.engineInfo = {
      hostPort: options.endpoint.hostPort,
      version: null,
      healthy: false,
      versionMatches: null,
    };
  }

  get endpoint(): EngineEndpoint {
    return this.options.endpoint;
  }

  get info(): EngineInfo {
    return { ...this.engineInfo };
  }

  /** True while the event socket is open. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private setInfo(patch: Partial<EngineInfo>): void {
    const next = { ...this.engineInfo, ...patch };
    const changed = JSON.stringify(next) !== JSON.stringify(this.engineInfo);
    this.engineInfo = next;
    if (changed) this.options.onInfo?.(this.info);
  }

  private baseUrl(): string {
    const port = this.options.endpoint.hostPort;
    if (port === null) {
      throw new ApiError(
        "conflict",
        `The engine of ${this.options.endpoint.container} has no host port yet.`,
      );
    }
    return `http://127.0.0.1:${port}`;
  }

  /** Checks the engine's health and version; updates `info`. */
  async health(): Promise<EngineHealth> {
    try {
      const health = EngineHealthSchema.parse(await this.request("GET", "/api/v1/health"));
      this.setInfo({
        healthy: true,
        version: health.engineVersion,
        // The engine compares itself with the version the server launched it
        // with; the server also compares with the version it expects now.
        versionMatches:
          health.versionMatches && health.engineVersion === this.options.expectedVersion,
      });
      return health;
    } catch (err) {
      this.setInfo({ healthy: false });
      throw err;
    }
  }

  /** Throws `engine_mismatch` when the engine's version is known to differ. */
  assertVersion(): void {
    if (this.engineInfo.versionMatches === false) {
      throw new ApiError(
        "engine_mismatch",
        `The engine in ${this.options.endpoint.container} is version ${this.engineInfo.version ?? "unknown"}, but this server needs ${this.options.expectedVersion}. Rebuild the image.`,
        { engineVersion: this.engineInfo.version, expected: this.options.expectedVersion },
      );
    }
  }

  /** Calls an engine route and validates the response against its schema. */
  async call(key: EngineRouteKey, input: EngineCallInput = {}): Promise<unknown> {
    const route = engineRoutes[key];
    if (route.kind !== "http") throw new Error(`${key} is not an HTTP route.`);
    const path = buildPath(route.path, (input.params ?? {}) as PathParams<string>);
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined && value !== null) query.set(name, String(value));
    }
    const qs = query.size > 0 ? `?${query.toString()}` : "";
    const body = await this.request(route.method, `${path}${qs}`, input.body);
    return route.response.parse(body);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const doFetch = this.options.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${this.baseUrl()}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.options.endpoint.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
      });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(
        "conflict",
        `The engine of ${this.options.endpoint.container} is not reachable: ${(err as Error).message}`,
      );
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      // A proxy or crash page (HTML, a plain-text 502) is not the engine's API.
      throw new ApiError(
        "internal",
        `The engine answered ${res.status} with a body that isn't JSON.`,
        undefined,
        502,
      );
    }
    if (!res.ok) {
      const parsed = ApiErrorSchema.safeParse(json);
      if (parsed.success) {
        const { code, message, details } = parsed.data.error;
        throw new ApiError(code, message, details, res.status);
      }
      throw new ApiError("internal", `The engine answered ${res.status}.`, undefined, 502);
    }
    return json;
  }

  /** Starts the event subscription; reconnects until `stop()`. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.terminate();
      });
    }
    this.setInfo({ healthy: false });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delays = this.options.backoffMs ?? DEFAULT_BACKOFF;
    const delay = delays[Math.min(this.attempt, delays.length - 1)] ?? 1000;
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.health();
    } catch (err) {
      this.options.log?.(
        `Engine ${this.options.endpoint.container} health check failed: ${(err as Error).message}`,
      );
      this.scheduleReconnect();
      return;
    }
    if (this.engineInfo.versionMatches === false) {
      // A mismatched engine gets no subscription; check again later in case
      // the container restarts with a rebuilt image.
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    // The engine token travels in the upgrade's header, never in the URL.
    const ws = new WebSocket(`ws://127.0.0.1:${this.options.endpoint.hostPort}/api/v1/events`, {
      headers: { authorization: `Bearer ${this.options.endpoint.token}` },
    });
    this.ws = ws;
    ws.on("open", () => {
      this.attempt = 0;
      const cursor = this.options.cursor.get();
      ws.send(
        JSON.stringify(
          ClientHelloSchema.parse({
            type: "hello",
            streamId: cursor?.streamId ?? null,
            lastSeq: cursor?.lastSeq ?? null,
          }),
        ),
      );
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      this.onFrame(ws, data.toString()).catch((err: unknown) => {
        this.options.log?.(
          `Engine ${this.options.endpoint.container} frame failed: ${(err as Error).message}`,
        );
      });
    });
    ws.on("error", (err) => {
      this.options.log?.(`Engine ${this.options.endpoint.container} socket error: ${err.message}`);
    });
    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    });
  }

  private async onFrame(ws: WebSocket, text: string): Promise<void> {
    let frame;
    try {
      frame = EngineStreamFrameSchema.parse(JSON.parse(text));
    } catch (err) {
      this.options.log?.(
        `Engine ${this.options.endpoint.container} sent an invalid frame: ${(err as Error).message}`,
      );
      return;
    }
    if (frame.type === "hello") {
      // Without a replay the server has missed whatever happened before, so
      // the owner reloads the engine's state through its REST routes.
      const cursor = this.options.cursor.get();
      this.options.cursor.set(
        frame.streamId,
        frame.replaying ? (cursor?.lastSeq ?? 0) : frame.lastSeq,
      );
      if (!frame.replaying) this.options.onResync?.();
      return;
    }
    if (frame.type === "lease.request") {
      const { type: _type, ...request } = frame;
      try {
        const response = await this.options.onLease(request);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify(LeaseResponseFrameSchema.parse({ type: "lease.response", response })),
          );
        }
      } catch (err) {
        const message = (err as Error).message;
        this.options.log?.(`Lease ${request.leaseId} failed: ${message}`);
        // Without an answer the engine's call waits for its own timeout, so
        // the failure pauses the run instead.
        if (ws.readyState === WebSocket.OPEN) {
          const response: LeaseResponse = {
            decision: "deny",
            leaseId: request.leaseId,
            reason: `The server could not decide the lease: ${message}`,
            action: "pause",
          };
          ws.send(
            JSON.stringify(LeaseResponseFrameSchema.parse({ type: "lease.response", response })),
          );
        }
      }
      return;
    }
    if (this.broken.has(ws)) return;
    // Relay first: the cursor moves past an event only once the hub has it.
    // After a failed relay, the socket is closed and later events on it are
    // dropped, so the reconnect replays from the last relayed event.
    try {
      this.options.onEvent(frame);
    } catch (err) {
      this.options.log?.(
        `Engine ${this.options.endpoint.container} event ${frame.seq} failed to relay: ${(err as Error).message}`,
      );
      this.broken.add(ws);
      ws.terminate();
      return;
    }
    this.options.cursor.set(frame.streamId, frame.seq);
  }
}
