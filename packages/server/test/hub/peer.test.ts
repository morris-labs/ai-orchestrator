// Two link peers over a real WebSocket on loopback, with fake servers on
// each end: requests, streams, credit-based flow control, and what happens
// when the link closes.
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { PendingRelay } from "../../src/api/machines.js";
import type { LinkStream } from "../../src/hub/link.js";
import { CreditSender, LinkPeer, type FlowStream, type LinkServer } from "../../src/hub/peer.js";
import {
  LINK_CAPABILITIES,
  LINK_PROTOCOL,
  MAX_LINK_PAYLOAD,
  STREAM_WINDOW,
  type LinkHello,
} from "../../src/hub/protocol.js";
import { waitFor } from "../events/fake-engine.js";

const hello = (capabilities = [...LINK_CAPABILITIES]): LinkHello => ({
  type: "hello",
  protocol: LINK_PROTOCOL,
  capabilities,
  serverVersion: "1.0.0-test",
  platform: "linux",
  name: "test",
  role: "node",
});

/** A local stream whose backlog the test sets, and that records what it got. */
class FakeSink implements FlowStream {
  got = 0;
  bufferedAmount = 0;
  paused = false;
  closedWith: number | null = null;
  private messageCb: ((data: Buffer, binary: boolean) => void) | null = null;
  private closeCb: ((code: number, reason: string) => void) | null = null;
  send(data: Buffer | string): void {
    this.got += Buffer.byteLength(data);
  }
  onMessage(cb: (data: Buffer, binary: boolean) => void): void {
    this.messageCb = cb;
  }
  close(code = 1000, reason = ""): void {
    this.closedWith = code;
    this.closeCb?.(code, reason);
  }
  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCb = cb;
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
  }
  emit(data: Buffer): void {
    this.messageCb?.(data, true);
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function pair(server: LinkServer, capabilities?: string[], timeoutMs?: number) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const accepted = new Promise<WebSocket>((r) => wss.once("connection", r));
  const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
  await new Promise<void>((r) => client.once("open", () => r()));
  const serverSocket = await accepted;
  const unused: LinkServer = {
    request: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }),
    openStream: async () => {
      throw new Error("No streams here.");
    },
  };
  const hubSide = new LinkPeer({
    socket: serverSocket,
    machineId: "m1",
    side: "h",
    hello: hello(capabilities),
    server: unused,
    timeoutMs,
  });
  const nodeSide = new LinkPeer({
    socket: client,
    machineId: "hub",
    side: "n",
    hello: hello(capabilities),
    server,
  });
  cleanups.push(() => {
    client.terminate();
    wss.close();
  });
  return { hubSide, nodeSide, client, serverSocket };
}

describe("link peers", () => {
  it("answers requests and fails pending ones when the link closes", async () => {
    let release: () => void = () => undefined;
    const { hubSide, client } = await pair({
      request: async (req) => {
        if (req.path === "/slow") await new Promise<void>((r) => (release = r));
        return {
          status: 200,
          headers: { "x-path": req.path },
          body: req.body ?? Buffer.from("none"),
        };
      },
      openStream: async () => {
        throw Object.assign(new Error("No such stream."), { status: 404 });
      },
    });
    const res = await hubSide.request({
      method: "POST",
      path: "/echo",
      headers: {},
      body: Buffer.from([0, 1, 2, 255]),
    });
    expect(res).toMatchObject({ status: 200, headers: { "x-path": "/echo" } });
    expect([...res.body]).toEqual([0, 1, 2, 255]);
    await expect(hubSide.openStream({ path: "/none", headers: {} })).rejects.toMatchObject({
      status: 404,
    });

    const slow = hubSide.request({ method: "GET", path: "/slow", headers: {} });
    let closed = false;
    hubSide.onClose(() => {
      closed = true;
    });
    client.terminate();
    await expect(slow).rejects.toThrow(/closed/);
    await waitFor(() => closed);
    release();
  });

  it("drops the other end's requests and streams once it closes the link", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const accepted = new Promise<WebSocket>((r) => wss.once("connection", r));
    const client = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
    await new Promise<void>((r) => client.once("open", () => r()));
    const socket = await accepted;
    cleanups.push(() => {
      client.terminate();
      wss.close();
    });
    const served: string[] = [];
    const peer = new LinkPeer({
      socket,
      machineId: "m1",
      side: "h",
      hello: hello(),
      server: {
        request: async (req) => {
          served.push(req.path);
          return { status: 200, headers: {}, body: Buffer.alloc(0) };
        },
        openStream: async (req) => {
          served.push(req.path);
          throw new Error("No streams here.");
        },
      },
    });
    const req = (path: string) =>
      JSON.stringify({ type: "req", id: path, method: "GET", path, headers: {} });
    // The first request proves that frames arrive; the rest follow the close.
    client.send(req("/before"));
    await waitFor(() => served.length === 1);
    const clientClosed = new Promise<void>((r) => client.once("close", () => r()));
    peer.close(4403, "Revoked.");
    client.send(req("/after"));
    client.send(JSON.stringify({ type: "open", id: "o1", path: "/after-stream", headers: {} }));
    await clientClosed;
    expect(served).toEqual(["/before"]);
  });

  it("lets a request set its own timeout, and names a timeout's error code", async () => {
    let finish: () => void = () => undefined;
    const { hubSide } = await pair(
      {
        request: async () => {
          await new Promise<void>((r) => (finish = r));
          return { status: 200, headers: {}, body: Buffer.alloc(0) };
        },
        openStream: async () => {
          throw new Error("No streams here.");
        },
      },
      undefined,
      20,
    );
    const req = { method: "POST", path: "/slow", headers: {} };
    await expect(hubSide.request(req)).rejects.toMatchObject({
      status: 504,
      code: "machine_timeout",
    });
    const long = hubSide.request(req, { timeoutMs: 5000 });
    await new Promise((r) => setTimeout(r, 100));
    finish();
    await expect(long).resolves.toMatchObject({ status: 200 });
  });

  it("holds a sender back until the receiver's sink drains", async () => {
    const source = new FakeSink();
    const { hubSide } = await pair({
      request: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
      openStream: async () => source,
    });
    const stream = (await hubSide.openStream({ path: "/s", headers: {} })) as LinkStream & {
      out: CreditSender;
    };
    // The node's source sends 3 windows; the hub's consumer takes each at once.
    let received = 0;
    stream.onMessage((data) => {
      received += data.length;
    });
    const chunk = Buffer.alloc(256 * 1024, 7);
    for (let i = 0; i < 12; i++) source.emit(chunk);
    await waitFor(() => received === 12 * chunk.length, 5000);

    // The other way: the node's sink reports a backlog, so the hub's sends wait.
    source.bufferedAmount = STREAM_WINDOW;
    for (let i = 0; i < 12; i++) stream.send(chunk, true);
    await waitFor(() => source.got >= STREAM_WINDOW, 5000);
    await new Promise((r) => setTimeout(r, 100));
    expect(source.got).toBeLessThan(12 * chunk.length);
    expect(stream.out.queuedBytes).toBeGreaterThan(0);
    source.bufferedAmount = 0;
    await waitFor(() => source.got === 12 * chunk.length, 5000);
    expect(stream.out.queuedBytes).toBe(0);
  });

  it("holds the other end's source back while the opener's sink has a backlog", async () => {
    const source = new FakeSink();
    const { hubSide } = await pair({
      request: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
      openStream: async () => source,
    });
    const stream = await hubSide.openStream({ path: "/s", headers: {} });
    let backlog = STREAM_WINDOW;
    stream.setSinkBacklog?.(() => backlog);
    let received = 0;
    stream.onMessage((data) => {
      received += data.length;
    });
    const chunk = Buffer.alloc(256 * 1024, 7);
    for (let i = 0; i < 12; i++) source.emit(chunk);
    // The node sends one window, then pauses its source for want of credit.
    await waitFor(() => received >= STREAM_WINDOW && source.paused, 5000);
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toBe(STREAM_WINDOW);
    // The sink drains, so the credit goes back and the rest arrives.
    backlog = 0;
    await waitFor(() => received === 12 * chunk.length && !source.paused, 5000);
  });

  it("pauses a local source while the other end grants no credit, and sends freely without flow.v1", () => {
    const sent: number[] = [];
    let paused = false;
    const sender = new CreditSender(
      (d) => sent.push(d.length),
      true,
      () => (paused = true),
      () => (paused = false),
    );
    sender.push(Buffer.alloc(STREAM_WINDOW + 1), true);
    sender.push(Buffer.alloc(10), true);
    expect(sent).toEqual([STREAM_WINDOW + 1]);
    expect(paused).toBe(true);
    sender.grant(STREAM_WINDOW);
    expect(sent).toEqual([STREAM_WINDOW + 1, 10]);
    expect(paused).toBe(false);

    const free = new CreditSender((d) => sent.push(d.length), false);
    for (let i = 0; i < 3; i++) free.push(Buffer.alloc(STREAM_WINDOW), true);
    expect(free.queuedBytes).toBe(0);
  });

  it("closes a stream on the other end when its open answers after the timeout", async () => {
    const sink = new FakeSink();
    let release: () => void = () => undefined;
    const { hubSide } = await pair(
      {
        request: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
        openStream: async () => {
          await new Promise<void>((r) => (release = r));
          return sink;
        },
      },
      undefined,
      50,
    );
    await expect(hubSide.openStream({ path: "/s", headers: {} })).rejects.toMatchObject({
      code: "machine_timeout",
    });
    release();
    await waitFor(() => sink.closedWith === 1001);
    expect(hubSide.isOpen).toBe(true);
  });

  it("pauses a relayed client while the receiver grants no credit", async () => {
    const sink = new FakeSink();
    sink.bufferedAmount = STREAM_WINDOW;
    const { hubSide } = await pair({
      request: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
      openStream: async () => sink,
    });
    const stream = await hubSide.openStream({ path: "/s", headers: {} });
    const client = Object.assign(new EventEmitter(), {
      paused: false,
      readyState: WebSocket.OPEN,
      OPEN: WebSocket.OPEN,
      bufferedAmount: 0,
      pause() {
        this.paused = true;
      },
      resume() {
        this.paused = false;
      },
      send: () => undefined,
      close: () => undefined,
    });
    new PendingRelay(stream, "m1", null).attach(client as unknown as WebSocket);

    client.emit("message", Buffer.alloc(STREAM_WINDOW), true);
    expect(client.paused).toBe(false);
    client.emit("message", Buffer.from("next"), true);
    expect(client.paused).toBe(true);

    await waitFor(() => sink.got === STREAM_WINDOW);
    sink.bufferedAmount = 0;
    await waitFor(() => !client.paused);
    await waitFor(() => sink.got === STREAM_WINDOW + 4);
  });

  it("resumes a paused source when the stream ends, so its socket can close", async () => {
    const sink = new FakeSink();
    sink.bufferedAmount = STREAM_WINDOW;
    const { hubSide } = await pair({
      request: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
      openStream: async () => sink,
    });
    const stream = await hubSide.openStream({ path: "/s", headers: {} });
    let paused = false;
    stream.setSource?.({
      pause: () => (paused = true),
      resume: () => (paused = false),
    });
    stream.send(Buffer.alloc(STREAM_WINDOW), true);
    stream.send(Buffer.from("next"), true);
    expect(paused).toBe(true);
    stream.close(1000, "");
    expect(paused).toBe(false);
  });

  it("sends a closed local stream's waiting output before its end", async () => {
    const sink = new FakeSink();
    const { hubSide } = await pair({
      request: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
      openStream: async () => sink,
    });
    const stream = await hubSide.openStream({ path: "/s", headers: {} });
    let backlog = STREAM_WINDOW;
    stream.setSinkBacklog?.(() => backlog);
    const got: string[] = [];
    let closed: number | null = null;
    stream.onMessage((data) => got.push(data.length === STREAM_WINDOW ? "full" : data.toString()));
    stream.onClose((code) => {
      closed = code;
      got.push("closed");
    });

    sink.emit(Buffer.alloc(STREAM_WINDOW));
    sink.emit(Buffer.from("tail"));
    sink.close(4001, "done");
    await waitFor(() => got.length === 1);

    backlog = 0;
    await waitFor(() => closed !== null);
    expect(got).toEqual(["full", "tail", "closed"]);
    expect(closed).toBe(4001);
  });

  it("refuses an oversized body or message and keeps the link", async () => {
    const huge = Buffer.alloc(MAX_LINK_PAYLOAD + 1);
    const sink = new FakeSink();
    const peerSink = new FakeSink();
    const sinks = [sink, peerSink];
    const { hubSide } = await pair({
      request: async (req) => ({
        status: 200,
        headers: {},
        body: req.path === "/huge" ? huge : Buffer.from("small"),
      }),
      openStream: async () => sinks.shift()!,
    });
    const req = { method: "POST", path: "/x", headers: {} };

    await expect(hubSide.request({ ...req, body: huge })).rejects.toMatchObject({
      status: 413,
      code: "validation",
    });
    expect((await hubSide.request({ ...req, path: "/huge" })).status).toBe(502);

    const fromNode = await hubSide.openStream({ path: "/s", headers: {} });
    let nodeClose: number | null = null;
    fromNode.onClose((code) => (nodeClose = code));
    sink.emit(huge);
    await waitFor(() => nodeClose === 1009);

    const toNode = await hubSide.openStream({ path: "/s", headers: {} });
    let hubClose: number | null = null;
    toNode.onClose((code) => (hubClose = code));
    toNode.send(huge, true);
    expect(hubClose).toBe(1009);
    await waitFor(() => peerSink.closedWith === 1009);

    expect(hubSide.isOpen).toBe(true);
    expect((await hubSide.request(req)).status).toBe(200);
  });

  it("logs why a socket failed", () => {
    const socket = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1 });
    const logged: string[] = [];
    new LinkPeer({
      socket: socket as unknown as WebSocket,
      machineId: "m1",
      side: "h",
      hello: hello(),
      server: {
        request: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
        openStream: async () => new FakeSink(),
      },
      log: (m) => logged.push(m),
    }).onClose(() => logged.push("closed"));
    socket.emit("error", new Error("Max payload size exceeded"));
    expect(logged).toEqual(["The link to m1 failed: Max payload size exceeded", "closed"]);
  });

  it("refuses a stream id that is in use or lacks the other end's prefix", async () => {
    const sinks: FakeSink[] = [];
    let gate: Promise<void> = Promise.resolve();
    const { hubSide, nodeSide, serverSocket } = await pair({
      request: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
      openStream: async () => {
        const sink = new FakeSink();
        sinks.push(sink);
        await gate;
        return sink;
      },
    });
    const failed: string[] = [];
    serverSocket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { type: string; id: string };
      if (frame.type === "openFailed") failed.push(frame.id);
    });
    const open = (id: string) => JSON.stringify({ type: "open", id, path: "/s", headers: {} });

    await hubSide.openStream({ path: "/s", headers: {} });
    serverSocket.send(open("h1"));
    serverSocket.send(open("n1"));
    await waitFor(() => failed.length === 2);
    expect(failed).toEqual(["h1", "n1"]);
    expect(sinks).toHaveLength(1);

    // The second arrives while the local server is still opening the first.
    let release: () => void = () => undefined;
    gate = new Promise<void>((r) => (release = r));
    serverSocket.send(open("h7"));
    serverSocket.send(open("h7"));
    await waitFor(() => failed.length === 3);
    expect(failed[2]).toBe("h7");
    expect(sinks).toHaveLength(2);
    release();

    nodeSide.close();
    expect(sinks[0]!.closedWith).toBe(1001);
  });

  it("streams without credit frames when the other end lacks flow.v1", async () => {
    const source = new FakeSink();
    const { hubSide } = await pair(
      {
        request: async () => ({ status: 200, headers: {}, body: Buffer.alloc(0) }),
        openStream: async () => source,
      },
      ["http.v1", "stream.v1"],
    );
    expect(hubSide.flow).toBe(false);
    const stream = await hubSide.openStream({ path: "/s", headers: {} });
    source.bufferedAmount = STREAM_WINDOW * 10;
    for (let i = 0; i < 8; i++) stream.send(Buffer.alloc(512 * 1024), true);
    await waitFor(() => source.got === 8 * 512 * 1024, 5000);
  });
});
