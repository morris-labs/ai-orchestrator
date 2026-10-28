// An in-memory server for tests: a `fetch` that answers the contract routes
// from handlers keyed by route name, validates every request body against
// the route's schema, and records each call.
import { serverRoutes, type ApiErrorCode, type HttpRouteDef } from "@agentbox/contracts";

export interface MockCall {
  key: string;
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

export type Handler = (call: MockCall) => unknown;

export class MockError {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    readonly message: string,
  ) {}
}

const compiled = Object.entries(serverRoutes)
  .filter(([, r]) => r.kind === "http")
  .map(([key, r]) => {
    const route = r as HttpRouteDef;
    const names: string[] = [];
    const pattern = route.path.replace(/:([A-Za-z0-9_]+)/g, (_m, n: string) => {
      names.push(n);
      return "([^/]+)";
    });
    return { key, route, names, re: new RegExp(`^${pattern}$`) };
  });

export interface MockServer {
  fetch: typeof fetch;
  calls: MockCall[];
  handlers: Record<string, Handler>;
  /** Extra handlers for paths outside the contract, keyed `METHOD path`. */
  raw: Record<string, Handler>;
  callsTo(key: string): MockCall[];
}

export function createMockServer(handlers: Record<string, Handler> = {}): MockServer {
  const server: MockServer = {
    calls: [],
    handlers,
    raw: {},
    callsTo: (key) => server.calls.filter((c) => c.key === key),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1:20400");
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      const query = Object.fromEntries(url.searchParams.entries());
      const json = (status: number, data: unknown) =>
        new Response(data === undefined ? "" : JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        });
      const run = (key: string, handler: Handler | undefined, params: Record<string, string>) => {
        const call: MockCall = { key, method, path: url.pathname, params, query, body, headers };
        server.calls.push(call);
        if (!handler)
          return json(404, { error: { code: "not_found", message: `No mock for ${key}.` } });
        try {
          const result = handler(call);
          return json(200, result);
        } catch (err) {
          if (err instanceof MockError)
            return json(err.status, { error: { code: err.code, message: err.message } });
          throw err;
        }
      };
      const rawKey = `${method} ${url.pathname}`;
      if (server.raw[rawKey]) return run(rawKey, server.raw[rawKey], {});
      for (const c of compiled) {
        if (c.route.method !== method) continue;
        const m = c.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(
          c.names.map((n, i) => [n, decodeURIComponent(m[i + 1]!)]),
        );
        if (c.route.body && body !== undefined) {
          const parsed = c.route.body.safeParse(body);
          if (!parsed.success) {
            return json(400, {
              error: { code: "validation", message: parsed.error.issues[0]?.message ?? "invalid" },
            });
          }
        }
        return run(c.key, server.handlers[c.key], params);
      }
      return run(rawKey, undefined, {});
    }) as typeof fetch,
  };
  return server;
}
