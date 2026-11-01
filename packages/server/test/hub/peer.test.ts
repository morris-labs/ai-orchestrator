// Two link peers over a real WebSocket on loopback, with fake servers on
// each end: requests, streams, credit-based flow control, and what happens
// when the link closes.
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { LinkStream } from "../../src/hub/link.js";
import { CreditSender, LinkPeer, type FlowStream, type LinkServer } from "../../src/hub/peer.js";
import {
  LINK_CAPABILITIES,
  LINK_PROTOCOL,
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
  private messageCb: ((data: Buffer, binary: boolean) => void) | null = null;
  private closeCb: ((code: number, reason: string) => void) | null = null;
  send(data: Buffer | string): void {
    this.got += Buffer.byteLength(data);
  }
  onMessage(cb: (data: Buffer, binary: boolean) => void): void {
    this.messageCb = cb;
  }
  close(code = 1000, reason = ""): void {
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

async function pair(server: LinkServer, capabilities?: string[]) {
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
  return { hubSide, nodeSide, client };
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
