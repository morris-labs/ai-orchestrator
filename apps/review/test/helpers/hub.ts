// A fake hub for the machine tests: one fake server per machine behind a
// fetch and a WebSocket that forward `/api/v1/machines/ID/proxy/REST` to
// machine ID's `/api/v1/REST`, as the server's machine proxy route does.
import type { Machine } from "@aio/contracts";
import { ApiClient, createMachineClient, type ApiClientOptions } from "@aio/ui/core";
import type { FakeServer } from "@aio/ui/testing";

const PROXY = /^\/api\/v1\/machines\/([^/]+)\/proxy(\/.*)?$/;

export function machine(over: Partial<Machine> & Pick<Machine, "id" | "name">): Machine {
  return {
    role: "node",
    status: "online",
    isLocal: false,
    serverVersion: "1.1.0",
    protocol: 1,
    capabilities: [],
    lastSeen: "2026-10-31T08:00:00.000Z",
    platform: "linux",
    ...over,
  };
}

export interface FakeHub {
  /** The machine list the hub answers, or `unsupported` for a 404. */
  machines: Machine[] | "unsupported";
  /** Machines whose calls answer with this error, as an unreachable node does. */
  failing: Record<string, { status: number; code: string; message: string }>;
  /** Every request as `METHOD /path`, before forwarding. */
  paths: string[];
  /** Every WebSocket path, before forwarding. */
  socketPaths: string[];
  /** This server's client. */
  client: ApiClient;
  /** Makes another machine's client, as the app does. */
  makeClient: (machineId: string) => ApiClient;
}

export function fakeHub(opts: {
  local: FakeServer;
  servers?: Record<string, FakeServer>;
  machines: Machine[] | "unsupported";
}): FakeHub {
  const servers = opts.servers ?? {};
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const route = (url: URL): { server: FakeServer; url: string; id: string } | null => {
    const m = PROXY.exec(url.pathname);
    if (!m) return { server: opts.local, url: url.href, id: "local" };
    const id = decodeURIComponent(m[1] ?? "");
    const server = id === "local" ? opts.local : servers[id];
    if (!server) return null;
    return { server, url: `${url.origin}/api/v1${m[2] ?? ""}${url.search}`, id };
  };
  const hub: FakeHub = {
    machines: opts.machines,
    failing: {},
    paths: [],
    socketPaths: [],
    client: null as unknown as ApiClient,
    makeClient: null as unknown as (id: string) => ApiClient,
  };
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    hub.paths.push(`${method} ${url.pathname}`);
    if (url.pathname === "/api/v1/machines" && method === "GET") {
      if (hub.machines === "unsupported")
        return json(404, { error: { code: "not_found", message: "No route." } });
      return json(200, { machines: hub.machines });
    }
    const target = route(url);
    if (!target)
      return json(503, {
        error: { code: "machine_offline", message: "The machine is not connected." },
      });
    const failure = hub.failing[target.id];
    if (failure) {
      return json(failure.status, { error: { code: failure.code, message: failure.message } });
    }
    return target.server.fetch(target.url, init);
  };
  const WebSocketCtor = class {
    constructor(url: string, options?: { headers?: Record<string, string> }) {
      const u = new URL(url);
      hub.socketPaths.push(u.pathname);
      const target = route(u);
      const server = target?.server ?? opts.local;
      return new server.WebSocket(target?.url ?? url, options);
    }
  };
  const options: ApiClientOptions = {
    baseUrl: "http://127.0.0.1:21400",
    fetch,
    WebSocket: WebSocketCtor as never,
  };
  hub.client = new ApiClient(options);
  hub.makeClient = (machineId) => createMachineClient(options, machineId);
  return hub;
}
