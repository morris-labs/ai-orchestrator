// The event stream client. It opens `events.stream`, sends the resume
// `hello`, validates every frame with the contract schema, and reconnects
// with backoff. When the server can't replay, `onReset` tells the caller to
// reload its state through the REST routes.
import {
  ClientHelloSchema,
  ServerStreamFrameSchema,
  serverRoutes,
  type AgentBoxEvent,
  type EventType,
} from "@agentbox/contracts";
import { toSearch } from "./api.js";

export type ConnectionState = "connecting" | "open" | "closed";

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface EventClientOptions {
  baseUrl?: string;
  token?: string | null;
  types?: readonly EventType[];
  /** Resume from here; usually the last cursor a previous client saw. */
  cursor?: { streamId: string; seq: number } | null;
  onEvent(event: AgentBoxEvent): void;
  onReset?(): void;
  onState?(state: ConnectionState): void;
  /** A frame that failed validation; it is dropped. */
  onInvalid?(raw: unknown, message: string): void;
  socket?: WebSocketFactory;
  /** Reconnect delays in milliseconds; the last one repeats. */
  backoff?: readonly number[];
}

/** Builds the `ws:` or `wss:` URL of the event stream. */
export function eventStreamUrl(
  baseUrl: string,
  token: string | null | undefined,
  types?: readonly EventType[],
): string {
  const origin =
    baseUrl ||
    (typeof location !== "undefined"
      ? `${location.protocol}//${location.host}`
      : "http://127.0.0.1:20400");
  const wsOrigin = origin.replace(/^http/, "ws").replace(/\/$/, "");
  return `${wsOrigin}${serverRoutes["events.stream"].path}${toSearch({
    types: types && types.length > 0 ? types.join(",") : undefined,
    token: token ?? undefined,
  })}`;
}

export class EventClient {
  private ws: WebSocketLike | null = null;
  private cursor: { streamId: string; seq: number } | null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly options: EventClientOptions) {
    this.cursor = options.cursor ?? null;
  }

  /** The last event position this client saw. */
  get position() {
    return this.cursor;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
    this.options.onState?.("closed");
  }

  private open(): void {
    const { baseUrl = "", token, types } = this.options;
    const factory: WebSocketFactory =
      this.options.socket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.options.onState?.("connecting");
    const ws = factory(eventStreamUrl(baseUrl, token, types));
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.options.onState?.("open");
      const hello = ClientHelloSchema.parse({
        type: "hello",
        streamId: this.cursor?.streamId ?? null,
        lastSeq: this.cursor?.seq ?? null,
      });
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (ev) => this.handle(ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.stopped) return;
      this.options.onState?.("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      // The close handler follows and reconnects.
    };
  }

  private scheduleReconnect(): void {
    const delays = this.options.backoff ?? [500, 1000, 2000, 5000, 10000];
    const delay = delays[Math.min(this.attempt, delays.length - 1)] ?? 5000;
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  /** Validates and dispatches one text frame. Public for tests. */
  handle(data: unknown): void {
    let json: unknown;
    try {
      json = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      this.options.onInvalid?.(data, "The frame isn't JSON.");
      return;
    }
    const parsed = ServerStreamFrameSchema.safeParse(json);
    if (!parsed.success) {
      this.options.onInvalid?.(json, parsed.error.issues[0]?.message ?? "Invalid frame.");
      return;
    }
    const frame = parsed.data;
    if (frame.type === "hello") {
      const resumed = frame.replaying && this.cursor?.streamId === frame.streamId;
      if (!resumed) {
        const hadState = this.cursor !== null;
        this.cursor = { streamId: frame.streamId, seq: frame.lastSeq };
        if (hadState) this.options.onReset?.();
      }
      return;
    }
    if (this.cursor && frame.streamId === this.cursor.streamId && frame.seq <= this.cursor.seq) {
      return; // Already seen.
    }
    this.cursor = { streamId: frame.streamId, seq: frame.seq };
    this.options.onEvent(frame);
  }
}
