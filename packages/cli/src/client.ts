// A typed client for the server API, built from the contracts' route table.
// Every call validates its query and body before it leaves and its response
// when it arrives.
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
import { z } from "zod";

/** The server routes served over plain HTTP. */
export type ServerHttpKey = {
  [K in ServerRouteKey]: ServerRoutes[K] extends { kind: "http" } ? K : never;
}[ServerRouteKey];

type Defined<T, V> = T extends undefined ? { [P in keyof V]?: never } : V;

/** What a call needs: path params, query, and body, each only when the route has one. */
export type CallInput<K extends ServerHttpKey> = (keyof RouteOf<K>["params"] extends never
  ? { params?: Record<string, never> }
  : { params: RouteOf<K>["params"] }) &
  Defined<RouteOf<K>["query"], { query?: RouteOf<K>["query"] }> &
  Defined<RouteOf<K>["body"], { body?: RouteOf<K>["body"] }>;

/**
 * Routes the CLI needs that the contracts don't have yet. `import.run`
 * stands in for the server's import route until the contracts add it.
 */
export const extraRoutes = {
  "import.run": {
    kind: "http",
    method: "POST",
    path: "/api/v1/import",
    auth: true,
    summary: "Import the 3.x records under ~/.claude-box into the database.",
    body: z.object({ dryRun: z.boolean().default(false) }),
    response: z.record(z.unknown()),
  },
} as const satisfies Record<string, HttpRouteDef>;

/** A failed call that returned an `ApiError` body. */
export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "unauthorized" | "unknown",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiCallError";
  }
}

/** The server couldn't be reached at all. */
export class ServerUnreachableError extends Error {
  constructor(
    readonly baseUrl: string,
    cause: unknown,
  ) {
    super(
      `Can't reach the Agent Box server at ${baseUrl}: ${String((cause as Error)?.message ?? cause)}`,
    );
    this.name = "ServerUnreachableError";
  }
}

export interface ClientOptions {
  baseUrl: string;
  /** `null` sends no `Authorization` header. */
  token: string | null;
  fetch?: typeof fetch;
}

function stringifyQuery(query: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) out[k] = String(v);
  return out;
}

export class ServerClient {
  private readonly fetch: typeof fetch;

  constructor(readonly options: ClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /** Calls a server route by its catalog key. */
  call<K extends ServerHttpKey>(key: K, input?: CallInput<K>): Promise<RouteOf<K>["response"]> {
    return this.request(serverRoutes[key] as HttpRouteDef, input ?? {}) as Promise<
      RouteOf<K>["response"]
    >;
  }

  /** Calls one of `extraRoutes`. */
  callExtra<K extends keyof typeof extraRoutes>(
    key: K,
    input: { body?: z.input<(typeof extraRoutes)[K]["body"]> } = {},
  ): Promise<z.infer<(typeof extraRoutes)[K]["response"]>> {
    return this.request(extraRoutes[key], input) as Promise<
      z.infer<(typeof extraRoutes)[K]["response"]>
    >;
  }

  /** Sends a request for any route definition. */
  async request(
    route: HttpRouteDef,
    input: { params?: Record<string, string>; query?: unknown; body?: unknown },
  ): Promise<unknown> {
    const path = buildPath(route.path, (input.params ?? {}) as never);
    const query = stringifyQuery(input.query as Record<string, unknown> | undefined);
    if (route.query) route.query.parse(query);
    const qs = new URLSearchParams(query).toString();
    const url = `${this.options.baseUrl.replace(/\/$/, "")}${path}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.options.token !== null) headers.authorization = `Bearer ${this.options.token}`;
    let body: string | undefined;
    if (route.body) {
      body = JSON.stringify(route.body.parse(input.body ?? {}));
      headers["content-type"] = "application/json";
    }
    let res: Response;
    try {
      res = await this.fetch(url, { method: route.method, headers, body });
    } catch (err) {
      throw new ServerUnreachableError(this.options.baseUrl, err);
    }
    const text = await res.text();
    let json: unknown = undefined;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      // Not JSON; handled below.
    }
    if (!res.ok) {
      const parsed = ApiErrorSchema.safeParse(json);
      if (res.status === 401) {
        throw new ApiCallError(
          401,
          "unauthorized",
          "The server refused the token. Check ~/.claude-box/server.token or AGENTBOX_TOKEN.",
        );
      }
      if (parsed.success) {
        const e = parsed.data.error;
        throw new ApiCallError(res.status, e.code, e.message, e.details);
      }
      throw new ApiCallError(
        res.status,
        "unknown",
        `The server answered ${res.status} ${res.statusText}.`,
      );
    }
    const out = route.response.safeParse(json);
    if (!out.success) {
      throw new ApiCallError(
        res.status,
        "unknown",
        `The server's answer to ${route.method} ${route.path} doesn't match the contract.`,
        out.error.issues,
      );
    }
    return out.data;
  }
}
