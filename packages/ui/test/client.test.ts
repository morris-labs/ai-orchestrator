import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiRequestError, isApiError } from "../src/core";
import { FakeServer, makeBoxView } from "../src/testing";

function setup() {
  const server = new FakeServer({
    boxes: [
      makeBoxView({ box: { id: "claude-agent-one", targetDir: "/work/one" }, status: "running" }),
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
    expect(res.boxes[0]?.box.id).toBe("claude-agent-one");
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
      .call("boxes.remove", { params: { boxId: "claude-agent-one" } })
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

  it("reports an unreachable server", async () => {
    const client = new ApiClient({
      fetch: async () => {
        throw new TypeError("connection refused");
      },
    });
    await expect(client.call("health", {})).rejects.toMatchObject({ code: "unreachable" });
  });

  it("builds WebSocket URLs with the token", () => {
    const { client } = setup();
    expect(client.wsUrl("events.stream", { query: { types: "box.changed" } })).toBe(
      "ws://127.0.0.1:21400/api/v1/events?types=box.changed&token=tok",
    );
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

      const start = client.call("boxes.start", { params: { boxId: "claude-agent-x" } });
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
