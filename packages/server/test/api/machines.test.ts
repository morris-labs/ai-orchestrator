import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { LinkStream } from "../../src/hub/link.js";
import {
  PendingRelay,
  RELAY_MAX_BUFFERED,
  forwardableHeaders,
  localMachineRewrite,
  parseProxyUrl,
  sendableCode,
  tagEventFrame,
} from "../../src/api/machines.js";
import { box, CONTAINER } from "./fixtures.js";
import { AUTH, TOKEN, createHarness, type Harness } from "./harness.js";
import { FakeNodeLink, FakeRegistry } from "./fake-link.js";
import { connect } from "./ws-client.js";
import { attachCmd } from "../../src/terminals/attach.js";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
const AUTH_B = { authorization: `Bearer ${TOKEN_B}` };

interface Fleet {
  hub: Harness;
  nodeA: Harness;
  nodeB: Harness;
  hubLinks: FakeRegistry;
  linkA: FakeNodeLink;
  /** nodeB's link to the hub. */
  linkHub: FakeNodeLink;
  hubUrl: string;
  nodeBUrl: string;
}

let fleet: Fleet;

/**
 * Three servers: a hub with links to two nodes, and node B, a plain node with
 * a link to the hub. Node B's link to the hub and the hub's link to node A
 * make node-to-hub-to-node forwarding possible.
 */
async function startFleet(): Promise<Fleet> {
  const nodeA = await createHarness({ token: TOKEN_A, machines: { role: "node" } });
  const portA = await nodeA.server.listen(0);
  const hubLinks = new FakeRegistry();
  const hub = await createHarness({
    links: hubLinks,
    machines: {
      role: "hub",
      machineId: "hub-pc",
      isKnown: (id) => id === "node-asleep",
      timeouts: { readMs: 300, writeMs: 300, openMs: 300 },
    },
  });
  const hubPort = await hub.server.listen(0);
  const linkA = new FakeNodeLink("node-a", `http://127.0.0.1:${portA}`, TOKEN_A);
  hubLinks.links.set("node-a", linkA);
  const nodeBLinks = new FakeRegistry();
  const nodeB = await createHarness({
    token: TOKEN_B,
    links: nodeBLinks,
    machines: { role: "node", machineId: "node-b" },
  });
  const portB = await nodeB.server.listen(0);
  hubLinks.links.set("node-b", new FakeNodeLink("node-b", `http://127.0.0.1:${portB}`, TOKEN_B));
  const linkHub = new FakeNodeLink("hub", `http://127.0.0.1:${hubPort}`, TOKEN);
  nodeBLinks.links.set("hub", linkHub);
  return {
    hub,
    nodeA,
    nodeB,
    hubLinks,
    linkA,
    linkHub,
    hubUrl: `http://127.0.0.1:${hubPort}/api/v1`,
    nodeBUrl: `http://127.0.0.1:${portB}/api/v1`,
  };
}

beforeEach(async () => {
  fleet = await startFleet();
});
afterEach(async () => {
  await fleet.hub.server.close();
  await fleet.nodeA.server.close();
  await fleet.nodeB.server.close();
});

async function json(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

describe("helpers", () => {
  it("parses a proxy URL and rewrites a local one", () => {
    expect(parseProxyUrl("/api/v1/machines/node-a/proxy/boxes/x?all=true")).toEqual({
      machineId: "node-a",
      rest: "boxes/x",
      query: "all=true",
    });
    expect(parseProxyUrl("/api/v1/boxes")).toBeNull();
    const rewrite = localMachineRewrite({ machineId: "hub-pc" });
    expect(rewrite("/api/v1/machines/local/proxy/boxes?x=1")).toBe("/api/v1/boxes?x=1");
    expect(rewrite("/api/v1/machines/hub-pc/proxy/events")).toBe("/api/v1/events");
    expect(rewrite("/api/v1/machines/node-a/proxy/events")).toBe(
      "/api/v1/machines/node-a/proxy/events",
    );
  });

  it("drops hop-by-hop, auth, and connection-named headers", () => {
    expect(
      forwardableHeaders(
        {
          connection: "keep-alive, x-private",
          "x-private": "1",
          authorization: "Bearer x",
          cookie: "a=b",
          host: "127.0.0.1",
          "content-length": "3",
          "content-type": "application/json",
          "sec-websocket-key": "k",
          accept: ["a", "b"],
        },
        "stream",
      ),
    ).toEqual({ "content-type": "application/json", accept: "a, b" });
    expect(forwardableHeaders({ "set-cookie": ["a=b"], "x-y": "z" }, "response")).toEqual({
      "x-y": "z",
    });
  });

  it("maps reserved close codes to ones a socket can send", () => {
    expect(sendableCode(1005)).toBe(1000);
    expect(sendableCode(1006)).toBe(1001);
    expect(sendableCode(4001)).toBe(4001);
    expect(sendableCode(1004)).toBe(1011);
  });

  it("tags event frames but not hello frames", () => {
    const tag = tagEventFrame("node-a");
    const event = JSON.parse(tag(Buffer.from('{"type":"box.changed","seq":3}')).toString());
    expect(event).toEqual({ type: "box.changed", seq: 3, machine: "node-a" });
    const hello = '{"type":"hello","streamId":"s","lastSeq":0,"replaying":false}';
    expect(tag(Buffer.from(hello)).toString()).toBe(hello);
  });
});

describe("the local machine", () => {
  it("answers the prefixed form like the plain route, with the same auth", async () => {
    const plain = await fetch(`${fleet.hubUrl}/boxes`, { headers: AUTH });
    const prefixed = await fetch(`${fleet.hubUrl}/machines/local/proxy/boxes`, { headers: AUTH });
    expect(prefixed.status).toBe(200);
    expect(await json(prefixed)).toEqual(await json(plain));
    const own = await fetch(`${fleet.hubUrl}/machines/hub-pc/proxy/boxes`, { headers: AUTH });
    expect(own.status).toBe(200);
    const anon = await fetch(`${fleet.hubUrl}/machines/local/proxy/boxes`);
    expect(anon.status).toBe(401);
    // The auth-free health route stays auth-free; the proxy route never is.
    expect((await fetch(`${fleet.hubUrl}/machines/local/proxy/health`)).status).toBe(200);
    expect((await fetch(`${fleet.hubUrl}/machines/node-a/proxy/health`)).status).toBe(401);
  });

  it("attaches a terminal through the prefixed form", async () => {
    const ws = fleet.hubUrl.replace(/^http/, "ws");
    const s = await connect(
      `${ws}/machines/local/proxy/terminals?kind=session&boxId=${box.id}&cols=80&rows=24`,
    );
    await s.until((x) => x.texts.length === 1);
    expect(s.texts[0]).toMatchObject({ type: "ready" });
    expect(fleet.hub.exec.requests).toHaveLength(1);
    s.ws.close();
  });

  it("refuses other machines on a server without links", async () => {
    const single = await createHarness();
    const port = await single.server.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/machines/node-a/proxy/boxes`, {
        headers: AUTH,
      });
      expect(res.status).toBe(404);
      expect(await json(res)).toMatchObject({
        error: { code: "not_found", message: expect.stringContaining('only "local"') },
      });
    } finally {
      await single.server.close();
    }
  });
});

describe("hub to node", () => {
  it("forwards a read with its query and without the client's credentials", async () => {
    const res = await fetch(`${fleet.hubUrl}/machines/node-a/proxy/notifications?unread=true`, {
      headers: { ...AUTH, cookie: "aio_session=x", "x-trace": "t1" },
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ notifications: [{ notificationId: "n1" }] });
    const sent = fleet.linkA.requests[0]!;
    expect(sent).toMatchObject({
      method: "GET",
      path: "/api/v1/notifications",
      query: "unread=true",
    });
    expect(sent.headers.authorization).toBeUndefined();
    expect(sent.headers.cookie).toBeUndefined();
    expect(sent.headers["x-trace"]).toBe("t1");
    expect(sent.headers["x-aio-forwarded-by"]).toBe("hub-pc");
  });

  it("forwards a write with its body, and the node's status and error body", async () => {
    const ok = await fetch(`${fleet.hubUrl}/machines/node-a/proxy/notifications/n1/read`, {
      method: "POST",
      headers: AUTH,
    });
    expect(ok.status).toBe(200);
    expect(fleet.nodeA.deps.notifications.list({ unread: true })).toEqual([]);
    const missing = await fetch(`${fleet.hubUrl}/machines/node-a/proxy/notifications/zz/read`, {
      method: "POST",
      headers: AUTH,
    });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ error: { code: "not_found" } });
    const body = { name: "renamed" };
    const patch = await fetch(`${fleet.hubUrl}/machines/node-a/proxy/settings`, {
      method: "PATCH",
      headers: { ...AUTH, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const sent = fleet.linkA.requests.at(-1)!;
    expect(sent.method).toBe("PATCH");
    expect(sent.body?.toString()).toBe(JSON.stringify(body));
    expect(sent.headers["content-type"]).toBe("application/json");
    // Whatever the node answers, the hub relays it unchanged.
    const direct = await fleet.linkA.request({
      method: "PATCH",
      path: "/api/v1/settings",
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(body)),
    });
    expect(patch.status).toBe(direct.status);
  });

  it("answers 404 for an unknown machine and 503 for an offline one", async () => {
    const unknown = await fetch(`${fleet.hubUrl}/machines/node-zz/proxy/boxes`, { headers: AUTH });
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toMatchObject({
      error: { code: "not_found", message: "No machine has the ID node-zz." },
    });
    const asleep = await fetch(`${fleet.hubUrl}/machines/node-asleep/proxy/boxes`, {
      headers: AUTH,
    });
    expect(asleep.status).toBe(503);
    expect(await json(asleep)).toMatchObject({ error: { code: "machine_offline" } });
  });

  it("answers 503 when the link fails and 504 when the node is too slow", async () => {
    fleet.linkA.fail = new Error("socket closed");
    const failed = await fetch(`${fleet.hubUrl}/machines/node-a/proxy/boxes`, { headers: AUTH });
    expect(failed.status).toBe(503);
    expect(await json(failed)).toMatchObject({
      error: { code: "machine_offline", message: expect.stringContaining("socket closed") },
    });
    fleet.linkA.fail = null;
    fleet.linkA.delayMs = 1000;
    const slow = await fetch(`${fleet.hubUrl}/machines/node-a/proxy/boxes`, { headers: AUTH });
    expect(slow.status).toBe(504);
    expect(await json(slow)).toMatchObject({
      error: { code: "machine_timeout", message: expect.stringContaining("node-a") },
    });
  });

  it("refuses a body over the API's size limit", async () => {
    const res = await fetch(`${fleet.hubUrl}/machines/node-a/proxy/settings`, {
      method: "PATCH",
      headers: { ...AUTH, "content-type": "application/octet-stream" },
      body: Buffer.alloc(2 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
    expect(fleet.linkA.requests).toHaveLength(0);
  });
});

describe("WebSocket relay", () => {
  const terminalPath = `terminals?kind=session&boxId=${box.id}&cols=100&rows=30`;

  it("relays a terminal both ways, with control frames and close", async () => {
    const ws = fleet.hubUrl.replace(/^http/, "ws");
    const s = await connect(`${ws}/machines/node-a/proxy/${terminalPath}`);
    await s.until((x) => x.texts.length === 1);
    expect(s.texts[0]).toMatchObject({ type: "ready" });
    expect(fleet.linkA.streams[0]).toMatchObject({
      path: "/api/v1/terminals",
      query: `kind=session&boxId=${box.id}&cols=100&rows=30`,
    });
    expect(fleet.nodeA.exec.requests[0]).toMatchObject({
      container: CONTAINER,
      cmd: attachCmd(box.session),
    });
    expect(fleet.hub.exec.requests).toHaveLength(0);

    const container = fleet.nodeA.exec.sessions[0]!.container;
    container.write(Buffer.from([0x1b, 0x5b, 0x48, 0xff]));
    await s.until((x) => x.binary.length > 0);
    expect([...Buffer.concat(s.binary)]).toEqual([0x1b, 0x5b, 0x48, 0xff]);

    const received: Buffer[] = [];
    container.on("data", (d: Buffer) => received.push(d));
    s.ws.send(Buffer.from("ls\r"));
    s.ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await s.until(
      () => Buffer.concat(received).toString() === "ls\r" && fleet.nodeA.exec.sizes.length === 1,
    );
    expect(fleet.nodeA.exec.sizes[0]).toEqual([120, 40]);

    // The client closes: the node's exec closes too.
    s.ws.close(1000, "tab closed");
    await s.until(() => fleet.nodeA.exec.sessions[0]!.closed);
  });

  it("relays the node's exit and close code to the client", async () => {
    const ws = fleet.hubUrl.replace(/^http/, "ws");
    const s = await connect(`${ws}/machines/node-a/proxy/${terminalPath}`);
    await s.until((x) => x.texts.length === 1);
    fleet.nodeA.exec.sessions[0]!.exitCode = 3;
    fleet.nodeA.exec.sessions[0]!.container.end();
    await s.until((x) => x.texts.length === 2);
    expect(s.texts[1]).toEqual({ type: "exit", exitCode: 3 });
    expect(await s.closed).toEqual({ code: 1000, reason: "ended" });
  });

  it("refuses the upgrade with the error status when the machine can't be reached", async () => {
    const ws = fleet.hubUrl.replace(/^http/, "ws");
    await expect(connect(`${ws}/machines/node-zz/proxy/${terminalPath}`)).rejects.toThrow(
      "HTTP 404",
    );
    fleet.linkA.delayMs = 1000;
    await expect(connect(`${ws}/machines/node-a/proxy/${terminalPath}`)).rejects.toThrow(
      "HTTP 504",
    );
    await expect(connect(`${ws}/machines/node-a/proxy/${terminalPath}`, {})).rejects.toThrow(
      "HTTP 401",
    );
  });

  it("closes the client with 1014 when the link drops", async () => {
    const ws = fleet.hubUrl.replace(/^http/, "ws");
    const s = await connect(`${ws}/machines/node-a/proxy/${terminalPath}`);
    await s.until((x) => x.texts.length === 1);
    // Ending node A's server drops its sockets without a close frame.
    await fleet.nodeA.server.close();
    const closed = await s.closed;
    expect(closed.code).toBe(1014);
    expect(closed.reason).toContain("node-a");
  });

  it("tags the node's events with the machine", async () => {
    const ws = fleet.hubUrl.replace(/^http/, "ws");
    const s = await connect(`${ws}/machines/node-a/proxy/events`);
    s.ws.send(JSON.stringify({ type: "hello", streamId: null, lastSeq: null }));
    await s.until((x) => x.texts.length === 1);
    expect(s.texts[0]).toMatchObject({ type: "hello", streamId: fleet.nodeA.hub.streamId });
    expect(s.texts[0]).not.toHaveProperty("machine");
    fleet.nodeA.hub.emit({ type: "box.changed", boxId: box.id, status: "running", box: null });
    await s.until((x) => x.texts.length === 2);
    expect(s.texts[1]).toMatchObject({ type: "box.changed", seq: 1, machine: "node-a" });
    s.ws.close();
  });
});

describe("node to hub to node", () => {
  it("forwards a call unchanged to the hub, which routes it to the node", async () => {
    const res = await fetch(`${fleet.nodeBUrl}/machines/node-a/proxy/notifications?unread=true`, {
      headers: AUTH_B,
    });
    expect(res.status).toBe(200);
    expect(fleet.linkHub.requests[0]).toMatchObject({
      method: "GET",
      path: "/api/v1/machines/node-a/proxy/notifications",
      query: "unread=true",
    });
    expect(fleet.linkHub.requests[0]!.headers.authorization).toBeUndefined();
    expect(fleet.linkA.requests[0]).toMatchObject({ path: "/api/v1/notifications" });
    expect(fleet.linkA.requests[0]!.headers["x-aio-forwarded-by"]).toBe("node-b, hub-pc");
  });

  it("relays the hub's errors and its own when the hub is away", async () => {
    const unknown = await fetch(`${fleet.nodeBUrl}/machines/node-zz/proxy/boxes`, {
      headers: AUTH_B,
    });
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toMatchObject({ error: { code: "not_found" } });
    // Node B's own ID resolves locally, without the hub.
    const own = await fetch(`${fleet.nodeBUrl}/machines/node-b/proxy/boxes`, { headers: AUTH_B });
    expect(own.status).toBe(200);
    expect(fleet.linkHub.requests).toHaveLength(1);
    fleet.linkHub.fail = new Error("hub went away");
    const away = await fetch(`${fleet.nodeBUrl}/machines/node-a/proxy/boxes`, { headers: AUTH_B });
    expect(away.status).toBe(503);
    expect(await json(away)).toMatchObject({
      error: { code: "machine_offline", message: expect.stringContaining("hub went away") },
    });
  });

  it("relays a terminal across two links", async () => {
    const ws = fleet.nodeBUrl.replace(/^http/, "ws");
    const s = await connect(`${ws}/machines/node-a/proxy/${terminalPath()}`, AUTH_B);
    await s.until((x) => x.texts.length === 1);
    expect(s.texts[0]).toMatchObject({ type: "ready" });
    expect(fleet.nodeA.exec.requests).toHaveLength(1);
    const container = fleet.nodeA.exec.sessions[0]!.container;
    container.write("from node a");
    await s.until((x) => Buffer.concat(x.binary).toString() === "from node a");
    const received: Buffer[] = [];
    container.on("data", (d: Buffer) => received.push(d));
    s.ws.send(Buffer.from("echo\r"));
    await s.until(() => Buffer.concat(received).toString() === "echo\r");
    s.ws.close(4000, "done");
    await s.until(() => fleet.nodeA.exec.sessions[0]!.closed);
  });

  it("answers 503 on a plain node without a hub link", async () => {
    const lonely = await createHarness({ links: new FakeRegistry(), machines: { role: "node" } });
    const port = await lonely.server.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/machines/node-a/proxy/boxes`, {
        headers: AUTH,
      });
      expect(res.status).toBe(503);
      expect(await json(res)).toMatchObject({
        error: { code: "machine_offline", message: expect.stringContaining("hub") },
      });
    } finally {
      await lonely.server.close();
    }
  });
});

function terminalPath(): string {
  return `terminals?kind=session&boxId=${box.id}`;
}

describe("relay backpressure", () => {
  /** A link stream double that the test drives from the node's side. */
  function fakeStream() {
    const sent: [string, boolean][] = [];
    const closes: [number | undefined, string | undefined][] = [];
    let message: (data: Buffer, binary: boolean) => void = () => undefined;
    let close: (code: number, reason: string) => void = () => undefined;
    const stream: LinkStream = {
      send: (data, binary) => void sent.push([data.toString(), binary]),
      onMessage: (cb) => (message = cb),
      close: (code, reason) => void closes.push([code, reason]),
      onClose: (cb) => (close = cb),
    };
    return {
      stream,
      sent,
      closes,
      message: (d: string) => message(Buffer.from(d), true),
      close: (code: number, reason: string) => close(code, reason),
    };
  }

  class FakeSocket extends EventEmitter {
    readonly OPEN = WebSocket.OPEN;
    readyState: number = WebSocket.OPEN;
    bufferedAmount = 0;
    readonly frames: string[] = [];
    closedWith: [number, string] | null = null;
    send(data: Buffer): void {
      this.frames.push(data.toString());
    }
    close(code: number, reason: string): void {
      this.closedWith = [code, reason];
      this.readyState = WebSocket.CLOSED;
    }
  }

  it("queues frames until the socket attaches, then sends them in order", () => {
    const f = fakeStream();
    const relay = new PendingRelay(f.stream, "node-a", null);
    f.message("one");
    f.message("two");
    const socket = new FakeSocket();
    relay.attach(socket as unknown as WebSocket);
    f.message("three");
    expect(socket.frames).toEqual(["one", "two", "three"]);
    socket.emit("message", Buffer.from("in"), true);
    expect(f.sent).toEqual([["in", true]]);
  });

  it("closes both sides when the client stops reading", () => {
    const f = fakeStream();
    const relay = new PendingRelay(f.stream, "node-a", null);
    const socket = new FakeSocket();
    relay.attach(socket as unknown as WebSocket);
    socket.bufferedAmount = RELAY_MAX_BUFFERED + 1;
    f.message("flood");
    expect(socket.closedWith?.[0]).toBe(1013);
    expect(f.closes[0]?.[0]).toBe(1013);
  });

  it("passes a close that arrives before the socket attaches", () => {
    const f = fakeStream();
    const relay = new PendingRelay(f.stream, "node-a", null);
    f.message("last words");
    f.close(4002, "box removed");
    const socket = new FakeSocket();
    relay.attach(socket as unknown as WebSocket);
    expect(socket.frames).toEqual(["last words"]);
    expect(socket.closedWith).toEqual([4002, "box removed"]);
    expect(f.closes).toEqual([]);
  });

  it("closes the stream when the upgrade never completes", () => {
    const f = fakeStream();
    new PendingRelay(f.stream, "node-a", null).cancel();
    expect(f.closes[0]?.[0]).toBe(1001);
  });
});
