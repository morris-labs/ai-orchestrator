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
export type CallArgs<K extends ServerRouteKey> = ParamsArg<K> & QueryArg<K> & BodyArg<K>;

/** The parsed response of route `K`. */
export type ResponseOf<K extends ServerRouteKey> = RouteOf<K>["response"];

/** A WebSocket constructor, injectable for tests and for Node. */
export type WebSocketCtor = new (url: string) => WebSocket;

export interface ApiClientOptions {
  /** Origin of the server, such as `http://127.0.0.1:20400`. Empty means the page's own origin. */
  baseUrl?: string;
  /** The bearer token. Absent means the `agentbox_session` cookie authenticates. */
  token?: string | null;
  fetch?: typeof fetch;
  WebSocket?: WebSocketCtor;
}

function queryString(query: Record<string, unknown> | undefined, extra?: Record<string, string>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  for (const [k, v] of Object.entries(extra ?? {})) sp.set(k, v);
  const s = sp.toString();
  return s === "" ? "" : `?${s}`;
}

/** The typed server API client. */
export class ApiClient {
  readonly baseUrl: string;
  readonly token: string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly wsCtor: WebSocketCtor | undefined;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.token = options.token ?? null;
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
    this.wsCtor = options.WebSocket ?? (globalThis.WebSocket as WebSocketCtor | undefined);
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
  async call<K extends HttpRouteKey>(key: K, args: CallArgs<K>): Promise<ResponseOf<K>> {
    const route = serverRoutes[key] as ServerRoutes[K] & {
      method: string;
      body?: z.ZodTypeAny;
      query?: z.ZodTypeAny;
      response: z.ZodTypeAny;
    };
    const a = args as { params?: unknown; query?: unknown; body?: unknown };
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
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(key, a), {
        method: route.method,
        headers,
        body,
        credentials: "same-origin",
      });
    } catch (err) {
      throw new ApiRequestError(
        "unreachable",
        `The Agent Box server is not reachable (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
    const text = await res.text();
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

  /** Builds the `ws://` URL of a WebSocket route, with the token as a query parameter. */
  wsUrl<K extends WsRouteKey>(
    key: K,
    args: { params?: Record<string, string>; query?: Record<string, unknown> } = {},
  ): string {
    const route = serverRoutes[key];
    const path = buildPath(route.path, (args.params ?? {}) as never);
    const origin =
      this.baseUrl !== ""
        ? this.baseUrl
        : typeof location !== "undefined"
          ? location.origin
          : "http://127.0.0.1:20400";
    const wsOrigin = origin.replace(/^http/, "ws");
    const extra: Record<string, string> = this.token ? { token: this.token } : {};
    return `${wsOrigin}${path}${queryString(args.query, extra)}`;
  }

  /** Opens a WebSocket route. */
  openSocket<K extends WsRouteKey>(
    key: K,
    args: { params?: Record<string, string>; query?: Record<string, unknown> } = {},
  ): WebSocket {
    if (!this.wsCtor) throw new Error("No WebSocket implementation is available.");
    return new this.wsCtor(this.wsUrl(key, args));
  }
}
