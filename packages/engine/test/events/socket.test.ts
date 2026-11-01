// The engine event WebSocket: hello, replay, resync, filtering, and leases.
import { EngineStreamFrameSchema } from "@aio/contracts";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CONTAINER, RUN, TOKEN, listenEngine } from "../api/fixtures.js";

type Engine = Awaited<ReturnType<typeof listenEngine>>;
let engine: Engine;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  engine?.leases.close();
  await engine?.app.close();
});

/** A client that queues every frame, validated against the engine frame schema. */
function connect(
  query = "",
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
) {
  const socket = new WebSocket(`${engine.ws}/api/v1/events?${query}`, { headers });
  sockets.push(socket);
  const frames: unknown[] = [];
  const waiters: (() => void)[] = [];
  socket.on("message", (data) => {
    frames.push(EngineStreamFrameSchema.parse(JSON.parse(data.toString())));
    waiters.splice(0).forEach((w) => w());
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (_req, res) =>
      reject(new Error(`status ${res.statusCode}`)),
    );
  });
  return {
    socket,
    opened,
    send: (frame: unknown) => socket.send(JSON.stringify(frame)),
    async take(n: number): Promise<Record<string, unknown>[]> {
      while (frames.length < n) await new Promise<void>((r) => waiters.push(r));
      return frames.splice(0, n) as Record<string, unknown>[];
    },
    pending: () => frames.length,
  };
}

const ports = { type: "ports.changed" as const, container: CONTAINER, listeners: [] };
const ask = {
  runId: RUN,
  vendor: "claude" as const,
  role: "fixer" as const,
  estimate: { tokens: 10 },
};

describe("engine.events", () => {
  it("closes a connected subscriber when the app closes", async () => {
    engine = await listenEngine();
    const c = connect();
    await c.opened;
    c.send({ type: "hello", streamId: null, lastSeq: null });
    await c.take(1);
    const closed = new Promise<number>((r) => c.socket.once("close", (code) => r(code)));
    const started = Date.now();
    await engine.app.close();
    expect(await closed).toBe(1001);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("refuses a connection without the token", async () => {
    engine = await listenEngine();
    await expect(connect("", {}).opened).rejects.toThrow("status 401");
    await expect(connect("", { authorization: "Bearer wrong" }).opened).rejects.toThrow(
      "status 401",
    );
  });

  it("refuses the token in the query string", async () => {
    engine = await listenEngine();
    await expect(connect(`token=${TOKEN}`, {}).opened).rejects.toThrow("status 401");
  });

  it("answers a first hello without replay and then streams live events", async () => {
    engine = await listenEngine();
    engine.hub.emit(ports);
    const c = connect();
    await c.opened;
    c.send({ type: "hello", streamId: null, lastSeq: null });
    expect(await c.take(1)).toEqual([
      { type: "hello", streamId: "stream-1", lastSeq: 1, replaying: false },
    ]);
    engine.hub.emit(ports);
    expect((await c.take(1))[0]).toMatchObject({ type: "ports.changed", seq: 2 });
  });

  it("sends nothing before the client's hello", async () => {
    engine = await listenEngine();
    const c = connect();
    await c.opened;
    engine.hub.emit(ports);
    await new Promise((r) => setTimeout(r, 30));
    expect(c.pending()).toBe(0);
  });

  it("replays events after the client's last seq, and resyncs on a second hello", async () => {
    engine = await listenEngine();
    for (let i = 0; i < 3; i++) engine.hub.emit(ports);
    const c = connect();
    await c.opened;
    c.send({ type: "hello", streamId: "stream-1", lastSeq: 1 });
    const frames = await c.take(3);
    expect(frames[0]).toEqual({ type: "hello", streamId: "stream-1", lastSeq: 3, replaying: true });
    expect(frames.slice(1).map((f) => f.seq)).toEqual([2, 3]);
    c.send({ type: "hello", streamId: "stream-1", lastSeq: 2 });
    const again = await c.take(2);
    expect(again.map((f) => f.type)).toEqual(["hello", "ports.changed"]);
    expect(again[1]?.seq).toBe(3);
    engine.hub.emit(ports);
    expect((await c.take(1))[0]?.seq).toBe(4);
  });

  it("does not replay for another stream id", async () => {
    engine = await listenEngine();
    engine.hub.emit(ports);
    const c = connect();
    await c.opened;
    c.send({ type: "hello", streamId: "old-stream", lastSeq: 0 });
    expect(await c.take(1)).toEqual([
      { type: "hello", streamId: "stream-1", lastSeq: 1, replaying: false },
    ]);
  });

  it("filters events by type but always sends control frames", async () => {
    engine = await listenEngine();
    const c = connect("types=run.changed");
    await c.opened;
    c.send({ type: "hello", streamId: null, lastSeq: null });
    await c.take(1);
    engine.hub.emit(ports);
    engine.leases.request(ask).catch(() => {});
    expect((await c.take(1))[0]).toMatchObject({ type: "lease.request" });
    expect(c.pending()).toBe(0);
  });

  it("ignores frames that don't match the contract", async () => {
    engine = await listenEngine();
    const c = connect();
    await c.opened;
    c.socket.send("not json");
    c.send({ type: "bogus" });
    c.send({ type: "hello", streamId: null, lastSeq: null });
    expect((await c.take(1))[0]).toMatchObject({ type: "hello" });
  });
});

describe("leases on engine.events", () => {
  it("sends a request to the subscriber and resolves on its response", async () => {
    engine = await listenEngine();
    const c = connect();
    await c.opened;
    c.send({ type: "hello", streamId: null, lastSeq: null });
    await c.take(1);
    const answer = engine.leases.request({ ...ask, leaseId: "L-1" });
    expect((await c.take(1))[0]).toEqual({ type: "lease.request", leaseId: "L-1", ...ask });
    c.send({
      type: "lease.response",
      response: {
        decision: "granted",
        leaseId: "L-1",
        vendor: "codex",
        redirectedFrom: "claude",
        expiresAt: "2099-01-01T00:00:00Z",
      },
    });
    await expect(answer).resolves.toMatchObject({ vendor: "codex", redirectedFrom: "claude" });
  });

  it("resends a pending request to a new subscription after a disconnect", async () => {
    engine = await listenEngine();
    const first = connect();
    await first.opened;
    first.send({ type: "hello", streamId: null, lastSeq: null });
    await first.take(1);
    const answer = engine.leases.request({ ...ask, leaseId: "L-7" });
    expect((await first.take(1))[0]).toMatchObject({ type: "lease.request", leaseId: "L-7" });
    first.socket.close();
    await new Promise((r) => first.socket.once("close", r));

    const second = connect();
    await second.opened;
    second.send({ type: "hello", streamId: "stream-1", lastSeq: 0 });
    const frames = await second.take(2);
    expect(frames.map((f) => f.type)).toEqual(["hello", "lease.request"]);
    expect(frames[1]).toMatchObject({ leaseId: "L-7" });
    second.send({
      type: "lease.response",
      response: {
        decision: "pause",
        leaseId: "L-7",
        resumeAt: "2099-01-01T00:00:00Z",
        reason: "ceiling",
      },
    });
    await expect(answer).resolves.toMatchObject({ decision: "pause" });
  });

  it("does not replay lease requests as events", async () => {
    engine = await listenEngine();
    engine.leases.request({ ...ask, leaseId: "L-2" }).catch(() => {});
    engine.hub.emit(ports);
    const c = connect();
    await c.opened;
    c.send({ type: "hello", streamId: "stream-1", lastSeq: 0 });
    const frames = await c.take(3);
    expect(frames.map((f) => f.type)).toEqual(["hello", "ports.changed", "lease.request"]);
    expect(frames[2]).not.toHaveProperty("seq");
  });
});
