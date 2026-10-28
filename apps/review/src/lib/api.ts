// A thin REST client built from the contracts route table. Every request
// body is validated before it leaves, and every response is parsed with the
// route's schema. At merge this gives way to the shared client in
// `packages/ui`, so it stays free of app logic.
import {
  ApiErrorSchema,
  buildPath,
  serverRoutes,
  type ApiErrorCode,
  type HttpRouteDef,
  type RouteOf,
  type ServerRouteKey,
  type ServerRoutes,
} from "@agentbox/contracts";

/** Names of the server's HTTP routes (WebSocket routes excluded). */
export type HttpKey = {
  [K in ServerRouteKey]: ServerRoutes[K] extends { kind: "http" } ? K : never;
}[ServerRouteKey];

export interface CallArgs<K extends HttpKey> {
  params?: RouteOf<K>["params"];
  query?: RouteOf<K>["query"];
  body?: RouteOf<K>["body"];
  signal?: AbortSignal;
}

/** A failed call: the server's error code and message, or a network failure. */
export class ApiCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ApiErrorCode | "network" | "bad_response",
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiCallError";
  }
}

export interface ApiClientOptions {
  /** Server origin, such as `http://127.0.0.1:20400`; empty means the page's own origin. */
  baseUrl?: string;
  /** Bearer token from the Electron preload; `null` relies on the session cookie. */
  token?: string | null;
  fetch?: typeof fetch;
}

/** Turns a query object into a search string; booleans become `true` and `false`. */
export function toSearch(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export interface ApiClient {
  readonly baseUrl: string;
  readonly token: string | null;
  call<K extends HttpKey>(key: K, args?: CallArgs<K>): Promise<RouteOf<K>["response"]>;
  /** An untyped request, for routes outside the contract. Returns the parsed JSON. */
  raw(
    method: string,
    path: string,
    init?: { query?: Record<string, unknown>; body?: unknown; signal?: AbortSignal },
  ): Promise<unknown>;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
  const token = options.token ?? null;
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));

  async function request(
    method: string,
    path: string,
    query: Record<string, unknown> | undefined,
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}${toSearch(query)}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new ApiCallError(
        `The server at ${baseUrl || "this origin"} did not answer.`,
        0,
        "network",
      );
    }
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiCallError(`The server sent a response that isn't JSON (${res.status}).`, res.status, "bad_response");
      }
    }
    if (!res.ok) {
      const parsed = ApiErrorSchema.safeParse(json);
      if (parsed.success) {
        const e = parsed.data.error;
        throw new ApiCallError(e.message, res.status, e.code, e.details);
      }
      throw new ApiCallError(`The request failed with status ${res.status}.`, res.status, "bad_response");
    }
    return json;
  }

  return {
    baseUrl,
    token,
    async call(key, args = {}) {
      const route = serverRoutes[key] as HttpRouteDef;
      const path = buildPath(route.path, (args.params ?? {}) as never);
      const body = route.body && args.body !== undefined ? route.body.parse(args.body) : args.body;
      const json = await request(
        route.method,
        path,
        args.query as Record<string, unknown> | undefined,
        body,
        args.signal,
      );
      const parsed = route.response.safeParse(json);
      if (!parsed.success) {
        throw new ApiCallError(
          `The response of ${key} doesn't match the contract: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
          200,
          "bad_response",
          parsed.error.issues,
        );
      }
      return parsed.data;
    },
    raw(method, path, init = {}) {
      return request(method, path, init.query, init.body, init.signal);
    },
  };
}

/** What the Electron preload exposes; absent in a plain browser. */
export interface AgentboxBridge {
  token: string | null;
  serverUrl: string | null;
  onNavigate?(listener: (hash: string) => void): () => void;
  setActiveRuns?(count: number): void;
}

export function bridge(): AgentboxBridge | undefined {
  return (globalThis as { agentbox?: AgentboxBridge }).agentbox;
}
