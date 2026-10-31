import { describe, expect, it, vi } from "vitest";
import { ApiClient, EventHub, EventsConnection, nextDelay, type WebSocketCtor } from "../src/core";
import type { FakeSocket } from "../src/testing";
import { FakeServer, makeEvent } from "../src/testing";

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const server = new FakeServer();
  const client = new ApiClient({
    baseUrl: "http://h",
    token: "t",
    fetch: server.fetch,
    WebSocket: server.WebSocket,
  });
  const events: string[] = [];
  const onResync = vi.fn();
  const timers: (() => void)[] = [];
  const conn = new EventsConnection({
    client,
    onEvent: (e) => events.push(`${e.type}#${e.seq}`),
    onResync,
    helloTimeoutMs: 0,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => undefined,
  });
  return { server, conn, events, onResync, timers };
}

const boxEvent = () =>
  makeEvent("box.changed", { boxId: "claude-agent-x", status: "running", box: null });

describe("EventsConnection", () => {
  it("asks a client factory again on every reconnect, so a token written later is used", async () => {
    const server = new FakeServer();
    const sent: (string | undefined)[] = [];
    const Recording = function (url: string, options?: { headers?: Record<string, string> }) {
      sent.push(options?.headers?.Authorization);
      return new server.WebSocket(url);
    } as unknown as WebSocketCtor;
    // The app starts before the server's first run, when there is no token yet.
    let token: string | null = null;
    const timers: (() => void)[] = [];
    const conn = new EventsConnection({
      client: () =>
        new ApiClient({
          baseUrl: "http://h",
          token,
          fetch: server.fetch,
          WebSocket: Recording,
          socketAuth: "header",
        }),
      onEvent: () => undefined,
      onResync: () => undefined,
      helloTimeoutMs: 0,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => undefined,
    });
    conn.start();
    await flush();
    token = "SYNTHETIC_TOKEN_WRITTEN_LATER";
    (server.socketsFor("/api/v1/events")[0] as FakeSocket).serverClose();
    timers[0]?.();
    await flush();
    expect(sent).toEqual([undefined, "Bearer SYNTHETIC_TOKEN_WRITTEN_LATER"]);
  });

  it("says hello and resyncs on the first connection", async () => {
    const { server, conn, onResync } = setup();
    conn.start();
    await flush();
    const sock = server.socketsFor("/api/v1/events")[0] as FakeSocket;
    expect(sock.sentJson[0]).toEqual({ type: "hello", streamId: null, lastSeq: null });
    expect(onResync).toHaveBeenCalledTimes(1);
    expect(conn.currentStatus).toBe("open");
  });

  it("delivers events in order", async () => {
    const { server, conn, events } = setup();
    conn.start();
    await flush();
    server.emit(boxEvent());
    server.emit(boxEvent());
    expect(events).toEqual(["box.changed#1", "box.changed#2"]);
  });

  it("replays after a reconnect without resyncing", async () => {
    const { server, conn, events, onResync, timers } = setup();
    conn.start();
    await flush();
    server.emit(boxEvent());
    (server.socketsFor("/api/v1/events")[0] as FakeSocket).serverClose();
    server.emit(boxEvent());
    server.emit(boxEvent());
    expect(timers).toHaveLength(1);
    timers[0]?.();
    await flush();
    const sock = server.socketsFor("/api/v1/events")[0] as FakeSocket;
    expect(sock.sentJson[0]).toEqual({ type: "hello", streamId: "fake-stream", lastSeq: 1 });
    expect(events).toEqual(["box.changed#1", "box.changed#2", "box.changed#3"]);
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("resyncs when the stream id changes", () => {
    const { conn, onResync } = setup();
    conn.handleFrame({ type: "hello", streamId: "a", lastSeq: 5, replaying: false });
    conn.handleFrame({ type: "hello", streamId: "b", lastSeq: 0, replaying: false });
    expect(onResync).toHaveBeenCalledTimes(2);
    expect(conn.position).toEqual({ streamId: "b", lastSeq: 0 });
  });

  it("asks for a replay on a gap and drops events until the answer", async () => {
    const { server, conn, events } = setup();
    conn.start();
    await flush();
    const sock = server.socketsFor("/api/v1/events")[0] as FakeSocket;
    conn.handleFrame({ ...boxEvent(), streamId: "fake-stream", seq: 3 });
    expect(sock.sentJson.at(-1)).toEqual({ type: "hello", streamId: "fake-stream", lastSeq: 0 });
    conn.handleFrame({ ...boxEvent(), streamId: "fake-stream", seq: 4 });
    expect(events).toEqual([]);
  });

  it("ignores duplicates and invalid frames", () => {
    const { conn, events } = setup();
    const bad = vi.fn();
    const c2 = new EventsConnection({
      client: new ApiClient(),
      onEvent: () => undefined,
      onResync: () => undefined,
      onInvalidFrame: bad,
    });
    c2.handleFrame({ type: "nope" });
    expect(bad).toHaveBeenCalled();
    conn.handleFrame({ type: "hello", streamId: "s", lastSeq: 2, replaying: false });
    conn.handleFrame({ ...boxEvent(), streamId: "s", seq: 2 });
    conn.handleFrame({ ...boxEvent(), streamId: "s", seq: 3 });
    expect(events).toEqual(["box.changed#3"]);
  });

  it("backs off exponentially up to the cap", () => {
    expect([0, 1, 2, 3, 10].map((a) => nextDelay(a, 500, 10_000))).toEqual([
      500, 1000, 2000, 4000, 10_000,
    ]);
  });

  it("spreads the delay with jitter", () => {
    expect(nextDelay(1, 500, 10_000, 0)).toBe(750);
    expect(nextDelay(1, 500, 10_000, 0.5)).toBe(1000);
    expect(nextDelay(1, 500, 10_000, 0.999)).toBeLessThanOrEqual(1250);
  });

  it("keeps backing off when the server closes before its hello", () => {
    class ClosingSocket {
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: unknown = null;
      onerror: unknown = null;
      readyState = 0;
      constructor(_url: string) {
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.();
          this.readyState = 3;
          this.onclose?.();
        });
      }
      send() {}
      close() {}
    }
    const delays: number[] = [];
    const timers: (() => void)[] = [];
    const conn = new EventsConnection({
      client: new ApiClient({
        baseUrl: "http://h",
        WebSocket: ClosingSocket as unknown as new (url: string) => WebSocket,
      }),
      onEvent: () => undefined,
      onResync: () => undefined,
      random: () => 0.5,
      helloTimeoutMs: 0,
      setTimer: (fn, ms) => {
        delays.push(ms);
        timers.push(fn);
      },
      clearTimer: () => undefined,
    });
    conn.start();
    return (async () => {
      for (let i = 0; i < 3; i += 1) {
        await flush();
        timers.shift()?.();
      }
      await flush();
      expect(delays).toEqual([500, 1000, 2000, 4000]);
      conn.stop();
    })();
  });

  it("keeps one socket when start() runs twice", async () => {
    const { server, conn } = setup();
    conn.start();
    conn.start();
    await flush();
    const sockets = server.socketsFor("/api/v1/events") as FakeSocket[];
    expect(sockets).toHaveLength(1);
    conn.stop();
    expect(sockets[0]?.readyState).toBe(3);
  });

  it("reconnects when the server never answers the hello", async () => {
    const opened: { close: () => void; onclose: (() => void) | null }[] = [];
    class SilentSocket {
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: unknown = null;
      onerror: unknown = null;
      readyState = 0;
      constructor(_url: string) {
        opened.push(this);
        queueMicrotask(() => {
          this.readyState = 1;
          this.onopen?.();
        });
      }
      send() {}
      close() {
        this.readyState = 3;
        this.onclose?.();
      }
    }
    const timers: { fn: () => void; ms: number }[] = [];
    const conn = new EventsConnection({
      client: new ApiClient({
        baseUrl: "http://h",
        WebSocket: SilentSocket as unknown as new (url: string) => WebSocket,
      }),
      onEvent: () => undefined,
      onResync: () => undefined,
      random: () => 0.5,
      helloTimeoutMs: 7_000,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => undefined,
    });
    conn.start();
    await flush();
    expect(conn.currentStatus).toBe("connecting");
    expect(timers.map((t) => t.ms)).toEqual([7_000]);
    timers.shift()?.fn();
    expect(conn.currentStatus).toBe("closed");
    expect(timers.map((t) => t.ms)).toEqual([500]);
    timers.shift()?.fn();
    await flush();
    expect(opened).toHaveLength(2);
    conn.stop();
  });

  it("stops without reconnecting", async () => {
    const { conn, timers } = setup();
    conn.start();
    await flush();
    conn.stop();
    expect(timers).toHaveLength(0);
    expect(conn.currentStatus).toBe("closed");
  });

  it("delivers no frame after stop, as Node's ws does for buffered frames", async () => {
    const { server, conn, events } = setup();
    conn.start();
    await flush();
    const sock = server.socketsFor("/api/v1/events")[0] as FakeSocket;
    server.emit(boxEvent());
    conn.stop();
    // `ws` fires `message` for frames it read before `close()` took effect.
    sock.serverSend({ ...boxEvent(), seq: 2, sourceSeq: 2 });
    expect(events).toEqual(["box.changed#1"]);
    expect(sock.onmessage).toBeNull();
  });
});

describe("EventHub", () => {
  it("routes events by type and to wildcard listeners", () => {
    const hub = new EventHub();
    const typed = vi.fn();
    const any = vi.fn();
    const off = hub.on("box.changed", typed);
    hub.on("*", any);
    hub.emit(boxEvent());
    off();
    hub.emit(boxEvent());
    expect(typed).toHaveBeenCalledTimes(1);
    expect(any).toHaveBeenCalledTimes(2);
  });

  it("keeps delivering to later handlers when one throws", () => {
    const hub = new EventHub();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const later = vi.fn();
    const any = vi.fn();
    hub.on("box.changed", () => {
      throw new Error("boom");
    });
    hub.on("box.changed", later);
    hub.on("*", () => {
      throw new Error("boom");
    });
    hub.on("*", any);
    expect(() => hub.emit(boxEvent())).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
    expect(any).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("tracks status and resyncs", () => {
    const hub = new EventHub();
    const status = vi.fn();
    const resync = vi.fn();
    hub.subscribeStatus(status);
    hub.onResync(resync);
    hub.setStatus("open");
    hub.setStatus("open");
    hub.resync();
    expect(status).toHaveBeenCalledTimes(1);
    expect(hub.getStatus()).toBe("open");
    expect(resync).toHaveBeenCalledTimes(1);
    expect(hub.resyncs).toBe(1);
  });
});
