// A typed client for the server API, built from the contracts route table.
//
// Every request body is checked against its route's schema before it leaves,
// and every response is parsed with its route's response schema, so a
// contract drift shows up as an `ApiRequestError` with code `bad_response`
// instead of as a broken screen.
import {
  buildPath,
  serverRoutes,
  type RouteOf,
  type ServerRouteKey,
  type ServerRoutes,
} from "@agentbox/contracts";
import type { z } from "zod";
import { ApiRequestError } from "./errors";

/** Route keys of the plain HTTP routes. */
export type HttpRouteKey = {
  [K in ServerRouteKey]: ServerRoutes[K] extends { kind: "http" } ? K : never;
}[ServerRouteKey];

/** Route keys of the WebSocket routes. */
export type WsRouteKey = {
  [K in ServerRouteKey]: ServerRoutes[K] extends { kind: "ws" } ? K : never;
}[ServerRouteKey];

type ParamsArg<K extends ServerRouteKey> = [keyof RouteOf<K>["params"]] extends [never]
  ? { params?: undefined }
  : { params: RouteOf<K>["params"] };
type QueryArg<K extends ServerRouteKey> = RouteOf<K>["query"] extends undefined
  ? { query?: undefined }
  : { query?: Partial<RouteOf<K>["query"]> };
type BodyArg<K extends ServerRouteKey> = RouteOf<K>["body"] extends undefined
  ? { body?: undefined }
  : undefined extends RouteOf<K>["body"]
    ? { body?: RouteOf<K>["body"] }
    : { body: RouteOf<K>["body"] };

/** What `call()` takes for route `K`: path params, query, and body as needed. */
export type CallArgs<K extends ServerRouteKey> = ParamsArg<K> &
  QueryArg<K> &
  BodyArg<K> & {
    /** Overrides the client's timeout for this call, in milliseconds. */
    timeoutMs?: number;
  };

/** How long a read waits for the server before it fails. */
export const READ_TIMEOUT_MS = 30_000;
/** How long a change waits; some, such as starting a box, take minutes. */
export const WRITE_TIMEOUT_MS = 10 * 60_000;

/**
 * The arguments of `call()` for route `K`: optional when the route needs no
 * path params and no body, so `call("usage.get")` works.
 */
export type CallArgsTuple<K extends ServerRouteKey> =
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  {} extends CallArgs<K> ? [args?: CallArgs<K>] : [args: CallArgs<K>];

/** The parsed response of route `K`. */
export type ResponseOf<K extends ServerRouteKey> = RouteOf<K>["response"];

/**
 * A WebSocket constructor, injectable for tests and for Node. The second
 * argument is passed only with `socketAuth: "header"`, for a constructor that
 * takes headers, such as the `ws` package.
 */
export type WebSocketCtor = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocket;

/**
 * How a WebSocket proves who it is. The token never goes in the URL.
 *
 * - `cookie`: the `agentbox_session` cookie, which a browser sends with the
 *   upgrade. Browsers can't set WebSocket headers, so a renderer with a token
 *   calls `startSession()` first to get the cookie.
 * - `header`: `Authorization: Bearer <token>` on the upgrade, for a
 *   constructor that takes headers (an Electron main process or Node).
 */
export type SocketAuth = "cookie" | "header";

export interface ApiClientOptions {
  /** Origin of the server, such as `https://127.0.0.1:21400`. Empty means the page's own origin. */
  baseUrl?: string;
  /** The bearer token. Absent means the `agentbox_session` cookie authenticates. */
  token?: string | null;
  fetch?: typeof fetch;
  WebSocket?: WebSocketCtor;
  /** How WebSockets authenticate. Default: `cookie`. */
  socketAuth?: SocketAuth;
  /** Timeouts in milliseconds for `GET` routes and for the others. */
  timeouts?: { readMs?: number; writeMs?: number };
}

function queryString(query: Record<string, unknown> | undefined) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s === "" ? "" : `?${s}`;
}

/** The typed server API client. */
export class ApiClient {
  readonly baseUrl: string;
  private bearer: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly wsCtor: WebSocketCtor | undefined;
  private readonly socketAuth: SocketAuth;

  private readonly readTimeoutMs: number;
  private readonly writeTimeoutMs: number;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.bearer = options.token ?? null;
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.wsCtor = options.WebSocket ?? (globalThis.WebSocket as WebSocketCtor | undefined);
    this.socketAuth = options.socketAuth ?? "cookie";
    this.readTimeoutMs = options.timeouts?.readMs ?? READ_TIMEOUT_MS;
    this.writeTimeoutMs = options.timeouts?.writeMs ?? WRITE_TIMEOUT_MS;
  }

  /** The bearer token, or `null` once the client authenticates with the cookie only. */
  get token(): string | null {
    return this.bearer;
  }

  /** Builds the URL of an HTTP route with its path params and query. */
  url<K extends ServerRouteKey>(key: K, args: { params?: unknown; query?: unknown } = {}): string {
    const route = serverRoutes[key];
    const path = buildPath(route.path, (args.params ?? {}) as never);
    return `${this.baseUrl}${path}${queryString(args.query as Record<string, unknown>)}`;
  }

  /**
   * Calls an HTTP route and returns its parsed response. Throws
   * `ApiRequestError` on a failed call, an invalid body, or a response that
   * doesn't match the contract.
   */
  async call<K extends HttpRouteKey>(key: K, ...rest: CallArgsTuple<K>): Promise<ResponseOf<K>> {
    const args = (rest[0] ?? {}) as CallArgs<K>;
    const route = serverRoutes[key] as ServerRoutes[K] & {
      method: string;
      body?: z.ZodTypeAny;
      query?: z.ZodTypeAny;
      response: z.ZodTypeAny;
    };
    const a = args as { params?: unknown; query?: unknown; body?: unknown; timeoutMs?: number };
    if (route.body && a.body !== undefined) {
      const check = route.body.safeParse(a.body);
      if (!check.success) {
        throw new ApiRequestError(
          "validation",
          check.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
          0,
          check.error.issues,
        );
      }
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (a.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(a.body);
    }
    // A server that accepts the connection and then stalls must not leave a
    // caller, and the "Starting..." row it shows, waiting forever.
    const timeoutMs =
      a.timeoutMs ?? (route.method === "GET" ? this.readTimeoutMs : this.writeTimeoutMs);
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(
          new ApiRequestError(
            "unreachable",
            `The Agent Box server didn't answer ${key} within ${Math.round(timeoutMs / 1000)} seconds.`,
          ),
        );
      }, timeoutMs);
    });
    timedOut.catch(() => undefined);
    let res: Response;
    let text: string;
    try {
      try {
        res = await Promise.race([
          this.fetchImpl(this.url(key, a), {
            method: route.method,
            headers,
            body,
            credentials: "same-origin",
            signal: abort.signal,
          }),
          timedOut,
        ]);
      } catch (err) {
        if (err instanceof ApiRequestError) throw err;
        throw new ApiRequestError(
          "unreachable",
          `The Agent Box server is not reachable (${err instanceof Error ? err.message : String(err)}).`,
        );
      }
      text = await Promise.race([res.text(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
    let json: unknown = undefined;
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiRequestError(
          "bad_response",
          `The server sent a body that isn't JSON.`,
          res.status,
        );
      }
    }
    if (!res.ok) throw ApiRequestError.fromResponse(res.status, json);
    const parsed = route.response.safeParse(json);
    if (!parsed.success) {
      throw new ApiRequestError(
        "bad_response",
        `The response of ${key} doesn't match the contract: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
        res.status,
        parsed.error.issues,
      );
    }
    return parsed.data as ResponseOf<K>;
  }

  /**
   * Trades the bearer token for the `agentbox_session` cookie, which a
   * browser WebSocket sends with its upgrade. Resolves `false` without a
   * token or when the server refuses; a page served by the server with the
   * cookie already set still connects.
   *
   * After a successful exchange the client forgets the token and
   * authenticates with the cookie only, so a page keeps no reusable
   * credential in reach of its scripts. A failed exchange keeps the token
   * for the bearer header.
   */
  async startSession(): Promise<boolean> {
    if (!this.bearer) return false;
    try {
      await this.call("auth.session", {});
      this.bearer = null;
      return true;
    } catch {
      return false;
    }
  }

  /** Builds the `wss://` or `ws://` URL of a WebSocket route. The token never goes in it. */
  wsUrl<K extends WsRouteKey>(
    key: K,
    args: { params?: Record<string, string>; query?: Record<string, unknown> } = {},
  ): string {
    const route = serverRoutes[key];
    const path = buildPath(route.path, (args.params ?? {}) as never);
    const origin = this.baseUrl !== "" ? this.baseUrl : (pageOrigin() ?? "https://127.0.0.1:21400");
    const wsOrigin = origin.replace(/^http/, "ws");
    return `${wsOrigin}${path}${queryString(args.query)}`;
  }

  /** Opens a WebSocket route. */
  openSocket<K extends WsRouteKey>(
    key: K,
    args: { params?: Record<string, string>; query?: Record<string, unknown> } = {},
  ): WebSocket {
    if (!this.wsCtor) throw new Error("No WebSocket implementation is available.");
    const url = this.wsUrl(key, args);
    if (this.socketAuth === "header" && this.token) {
      return new this.wsCtor(url, { headers: { Authorization: `Bearer ${this.token}` } });
    }
    return new this.wsCtor(url);
  }
}

/**
 * The page's origin in a browser, or `null` outside one. It reads
 * `location` through `globalThis`, so that this module type-checks without
 * the DOM library for an Electron main process.
 */
function pageOrigin(): string | null {
  const loc = (globalThis as { location?: { origin: string } }).location;
  return loc ? loc.origin : null;
}
