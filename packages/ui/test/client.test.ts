import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiRequestError, createMachineClient, isApiError } from "../src/core";
import { FakeServer, makeBoxView, type FakeSocket } from "../src/testing";
import { z } from "zod";

function setup() {
  const server = new FakeServer({
    boxes: [
      makeBoxView({ box: { id: "aio-agent-one", targetDir: "/work/one" }, status: "running" }),
    ],
  });
  const client = new ApiClient({
    baseUrl: "http://127.0.0.1:21400",
    token: "tok",
    fetch: server.fetch,
    WebSocket: server.WebSocket,
  });
  return { server, client };
}

describe("ApiClient", () => {
  it("builds URLs with params and query", () => {
    const { client } = setup();
    expect(client.url("boxes.get", { params: { boxId: "a b" } })).toBe(
      "http://127.0.0.1:21400/api/v1/boxes/a%20b",
    );
    expect(client.url("conversations.list", { query: { dir: "/x y" } })).toBe(
      "http://127.0.0.1:21400/api/v1/conversations?dir=%2Fx+y",
    );
  });

  it("parses a response with its route schema", async () => {
    const { client, server } = setup();
    const res = await client.call("boxes.list", {});
    expect(res.boxes[0]?.box.id).toBe("aio-agent-one");
    expect(server.contractViolations).toEqual([]);
  });

  it("sends the bearer token and a JSON body", async () => {
    let seen: RequestInit | undefined;
    const client = new ApiClient({
      token: "secret",
      fetch: async (_u, init) => {
        seen = init;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });
    await client.call("boxes.message", { params: { boxId: "b" }, body: { text: "hi" } });
    expect((seen?.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    expect(seen?.body).toBe(JSON.stringify({ text: "hi" }));
  });

  it("rejects an invalid body before sending", async () => {
    const { client, server } = setup();
    await expect(
      client.call("boxes.create", {
        body: { targetDir: "/w", layout: "worktree", conversationName: " " },
      }),
    ).rejects.toMatchObject({ code: "validation" });
    expect(server.callsTo("boxes.create")).toHaveLength(0);
  });

  it("turns an ApiError body into ApiRequestError", async () => {
    const { client } = setup();
    const err = await client
      .call("boxes.remove", { params: { boxId: "aio-agent-one" } })
      .catch((e: unknown) => e);
    expect(isApiError(err, "box_running")).toBe(true);
    expect((err as ApiRequestError).status).toBe(409);
  });

  it("reports a response that breaks the contract", async () => {
    const client = new ApiClient({
      fetch: async () => new Response(JSON.stringify({ boxes: [{}] }), { status: 200 }),
    });
    await expect(client.call("boxes.list", {})).rejects.toMatchObject({ code: "bad_response" });
  });

  it("keeps the status of an error response whose body isn't JSON", async () => {
    const client = new ApiClient({
      fetch: async () =>
        new Response("<html>Bad gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    });
    const err = await client.call("boxes.list", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(502);
    expect((err as ApiRequestError).message).toMatch(/status 502/);
    expect((err as ApiRequestError).details).toBe("<html>Bad gateway</html>");
  });

  it("reports an unreachable server", async () => {
    const client = new ApiClient({
      fetch: async () => {
        throw new TypeError("connection refused");
      },
    });
    await expect(client.call("health", {})).rejects.toMatchObject({ code: "unreachable" });
  });

  it("builds WebSocket URLs without the token", () => {
    const { client } = setup();
    expect(client.wsUrl("events.stream", { query: { types: "box.changed" } })).toBe(
      "ws://127.0.0.1:21400/api/v1/events?types=box.changed",
    );
  });

  it("leaves a browser socket to the cookie and sends the header when asked", () => {
    const { client, server } = setup();
    const browser = client.openSocket("events.stream") as unknown as FakeSocket;
    expect(browser.headers).toEqual({});
    expect(browser.url).not.toContain("tok");
    const node = new ApiClient({
      baseUrl: "http://127.0.0.1:21400",
      token: "tok",
      fetch: server.fetch,
      WebSocket: server.WebSocket,
      socketAuth: "header",
    });
    const socket = node.openSocket("events.stream") as unknown as FakeSocket;
    expect(socket.headers).toEqual({ Authorization: "Bearer tok" });
    expect(socket.url).toBe("ws://127.0.0.1:21400/api/v1/events");
  });

  it("trades the token for the session cookie", async () => {
    const calls: string[] = [];
    const fetchSpy: typeof fetch = async (input, init) => {
      calls.push(`${init?.method} ${String(input)} ${JSON.stringify(init?.headers)}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const withToken = new ApiClient({ baseUrl: "http://h", token: "tok", fetch: fetchSpy });
    expect(await withToken.startSession()).toBe(true);
    expect(calls[0]).toContain("POST http://h/api/v1/auth/session");
    expect(calls[0]).toContain("Bearer tok");
    expect(await new ApiClient({ baseUrl: "http://h", fetch: fetchSpy }).startSession()).toBe(
      false,
    );
    expect(calls).toHaveLength(1);
    const refusing = new ApiClient({
      baseUrl: "http://h",
      token: "bad",
      fetch: async () => new Response("{}", { status: 401 }),
    });
    expect(await refusing.startSession()).toBe(false);
  });

  it("forgets the token once the cookie authenticates, and keeps it when the trade fails", async () => {
    const headers: string[] = [];
    const fetchSpy: typeof fetch = async (_input, init) => {
      headers.push(JSON.stringify(init?.headers));
      return new Response(JSON.stringify({ boxes: [], ok: true }), { status: 200 });
    };
    const client = new ApiClient({
      baseUrl: "http://h",
      token: "SYNTHETIC_TOKEN",
      fetch: fetchSpy,
    });
    expect(await client.startSession()).toBe(true);
    expect(client.token).toBeNull();
    await client.call("boxes.list", {});
    expect(headers[1]).not.toContain("SYNTHETIC_TOKEN");
    expect(JSON.stringify(client)).not.toContain("SYNTHETIC_TOKEN");

    const refused = new ApiClient({
      baseUrl: "http://h",
      token: "SYNTHETIC_TOKEN",
      fetch: async () => new Response("{}", { status: 401 }),
    });
    expect(await refused.startSession()).toBe(false);
    expect(refused.token).toBe("SYNTHETIC_TOKEN");
  });

  it("falls back to an error for an unknown error body", () => {
    const e = ApiRequestError.fromResponse(500, "nope");
    expect(e.code).toBe("bad_response");
  });
});

describe("timeouts", () => {
  it("fails a request the server never answers", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const client = new ApiClient({
        baseUrl: "http://h",
        fetch: ((_url: string, init: RequestInit) => {
          signal = init.signal ?? undefined;
          return new Promise(() => undefined);
        }) as typeof fetch,
        timeouts: { readMs: 1000, writeMs: 5000 },
      });
      const read = client.call("boxes.list", {});
      const readCheck = expect(read).rejects.toMatchObject({ code: "unreachable" });
      await vi.advanceTimersByTimeAsync(1001);
      await readCheck;
      expect(signal?.aborted).toBe(true);

      const start = client.call("boxes.start", { params: { boxId: "aio-agent-x" } });
      let settled = false;
      start.catch(() => undefined).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(1001);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(4000);
      await expect(start).rejects.toThrow(/didn't answer boxes.start within 5 seconds/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("machine clients", () => {
  const base = { baseUrl: "https://127.0.0.1:21400", token: "tok" };

  it("sends every route through the machine proxy prefix", () => {
    const client = createMachineClient(base, "node a");
    expect(client.machineId).toBe("node a");
    expect(client.url("boxes.get", { params: { boxId: "b1" } })).toBe(
      "https://127.0.0.1:21400/api/v1/machines/node%20a/proxy/boxes/b1",
    );
    expect(client.wsUrl("terminals.open", { query: { kind: "session", boxId: "b1" } })).toBe(
      "wss://127.0.0.1:21400/api/v1/machines/node%20a/proxy/terminals?kind=session&boxId=b1",
    );
    // The session cookie belongs to the server the client talks to.
    expect(client.url("auth.session")).toBe("https://127.0.0.1:21400/api/v1/auth/session");
  });

  it("keeps the plain paths for local and for no machine", () => {
    for (const client of [new ApiClient(base), createMachineClient(base, "local")]) {
      expect(client.machineId).toBe("local");
      expect(client.url("boxes.list")).toBe("https://127.0.0.1:21400/api/v1/boxes");
      expect(client.wsUrl("events.stream")).toBe("wss://127.0.0.1:21400/api/v1/events");
    }
  });

  it("calls the prefixed URL", async () => {
    const urls: string[] = [];
    const client = createMachineClient(
      {
        token: "tok",
        fetch: async (u) => {
          urls.push(String(u));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
      "node-a",
    );
    await client.call("boxes.message", { params: { boxId: "b" }, body: { text: "hi" } });
    expect(urls).toEqual(["/api/v1/machines/node-a/proxy/boxes/b/message"]);
  });
});

describe("request", () => {
  it("calls a path the route table doesn't list, on the client's machine", async () => {
    const seen: { url: string; method?: string; body?: unknown }[] = [];
    const options = {
      fetch: async (u: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(u), method: init?.method, body: init?.body });
        return new Response(JSON.stringify({ n: 1 }), { status: 200 });
      },
    };
    const schema = z.object({ n: z.number() });
    const res = await new ApiClient(options).request("POST", "/api/v1/things", schema, {
      body: { a: 1 },
    });
    expect(res.n).toBe(1);
    expect(seen[0]).toEqual({ url: "/api/v1/things", method: "POST", body: '{"a":1}' });
    await createMachineClient(options, "node-a").request("GET", "/api/v1/things", schema);
    expect(seen[1]?.url).toBe("/api/v1/machines/node-a/proxy/things");
    await expect(
      new ApiClient(options).request("GET", "/api/v1/things", z.object({ n: z.string() })),
    ).rejects.toMatchObject({ code: "bad_response" });
  });
});
