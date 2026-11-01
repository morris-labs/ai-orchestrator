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
} from "@aio/contracts";
import { ServerCertificateDateError, ServerIdentityError } from "@aio/contracts/tls";
import { CertificateFileError, displayUrl } from "./settings.js";

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

/** A failed call that returned an `ApiError` body. */
export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "unknown",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiCallError";
  }
}

/** The server couldn't be reached at all. */
export class ServerUnreachableError extends Error {
  /**
   * False when starting the server won't help: the certificate is missing,
   * isn't the pinned one, or is outside its validity period.
   */
  readonly suggestStart: boolean;

  constructor(
    readonly baseUrl: string,
    cause: unknown,
  ) {
    const message = String((cause as Error)?.message ?? cause);
    // The global fetch says only "fetch failed"; the reason is one level down.
    const code = (cause as { cause?: { code?: unknown } })?.cause?.code;
    const detail =
      typeof code === "string" && !message.includes(code) ? `${message} (${code})` : message;
    super(`Can't reach the AI Orchestrator server at ${displayUrl(baseUrl)}: ${detail}`);
    this.name = "ServerUnreachableError";
    this.suggestStart = !(
      cause instanceof ServerIdentityError ||
      cause instanceof ServerCertificateDateError ||
      cause instanceof CertificateFileError
    );
  }
}

/** A call's path, query, or body failed its route's schema before it was sent. */
export class RequestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestInputError";
  }
}

/** The call stopped because its `signal` aborted, such as on Ctrl+C. */
export class InterruptedError extends Error {
  constructor() {
    super("Interrupted.");
    this.name = "InterruptedError";
  }
}

/** One line from a schema failure: `path: message` for each issue. */
function issuesText(
  where: string,
  error: { issues: { path: (string | number)[]; message: string }[] },
) {
  const parts = error.issues.map(
    (i) => `${i.path.length > 0 ? i.path.join(".") : where}: ${i.message}`,
  );
  return `Invalid ${where}: ${parts.join("; ")}.`;
}

export interface ClientOptions {
  baseUrl: string;
  /** `null` sends no `Authorization` header. */
  token: string | null;
  fetch?: typeof fetch;
  /** Aborts every call, such as on Ctrl+C. */
  signal?: AbortSignal;
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

  /** Sends a request for any route definition. */
  async request(
    route: HttpRouteDef,
    input: { params?: Record<string, string>; query?: unknown; body?: unknown },
  ): Promise<unknown> {
    let path: string;
    try {
      path = buildPath(route.path, (input.params ?? {}) as never);
    } catch (err) {
      throw new RequestInputError((err as Error).message);
    }
    const query = stringifyQuery(input.query as Record<string, unknown> | undefined);
    if (route.query) {
      const checked = route.query.safeParse(query);
      if (!checked.success) throw new RequestInputError(issuesText("query", checked.error));
    }
    const qs = new URLSearchParams(query).toString();
    const url = `${this.options.baseUrl.replace(/\/$/, "")}${path}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.options.token !== null) headers.authorization = `Bearer ${this.options.token}`;
    let body: string | undefined;
    if (route.body) {
      const checked = route.body.safeParse(input.body ?? {});
      if (!checked.success) throw new RequestInputError(issuesText("body", checked.error));
      body = JSON.stringify(checked.data);
      headers["content-type"] = "application/json";
    }
    const signal = this.options.signal;
    if (signal?.aborted) throw new InterruptedError();
    let res: Response;
    let text: string;
    try {
      res = await this.fetch(url, { method: route.method, headers, body, signal });
      text = await res.text();
    } catch (err) {
      if (signal?.aborted) throw new InterruptedError();
      throw new ServerUnreachableError(this.options.baseUrl, err);
    }
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
          "The server refused the token. Check server.token in the data directory (~/.ai-orchestrator or AIO_DATA_DIR), or AIO_TOKEN.",
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
