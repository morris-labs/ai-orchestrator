import { configureTestAccounts } from "../account-fixture.js";
// Terminal attach through the hub, end to end: whole servers in one process
// (a hub and one or two nodes, each with its own temporary home passed as an
// argument), joined over the real mutual TLS link. A client attaches to a
// box that runs on a node, through the hub's machine proxy route, and the
// tests check input, output, resize, detach, the node's exit, a node that
// goes offline mid-session, and flow control.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoxViewSchema, type BoxView } from "@aio/contracts";
import { pinFromPem, pinnedFetch, pinnedTlsOptions } from "@aio/contracts/tls";
import WebSocket from "ws";
import { startApp, type App } from "../../src/api/app.js";
import { createCore } from "../../src/core.js";
import { MemoryDocker } from "../../src/docker/memory.js";
import type { LinkPeer } from "../../src/hub/peer.js";
import { attachCmd } from "../../src/terminals/attach.js";
import { waitFor } from "../events/fake-engine.js";
import { FakeRunner } from "../setup/fake-runner.js";
import { FakeExec } from "../api/harness.js";
import { tempDir } from "../tmp.js";

const VERSION = "1.0.0-test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies the tests index freely
type Json = any;

const apps: App[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const app of apps.splice(0)) await app.close();
});

interface Server {
  app: App;
  home: string;
  exec: FakeExec;
  api(method: string, url: string, body?: unknown): Promise<{ status: number; json: Json }>;
  /** Opens a WebSocket to `url` on this server, with its token and pinned certificate. */
  open(url: string): Promise<Client>;
}

/** A terminal client: collects control frames and output bytes. */
interface Client {
  ws: WebSocket;
  texts: Json[];
  output: Buffer[];
  closed: Promise<{ code: number; reason: string }>;
  until(predicate: () => boolean, timeoutMs?: number): Promise<void>;
}

async function startServer(name: string): Promise<Server> {
  const home = fs.realpathSync(tempDir(`aio-term-${name}-`));
  const dataDir = path.join(home, "data");
  const docker = new MemoryDocker();
  docker.addImage("aio-agent", { "aio.engine-version": VERSION });
  const exec = new FakeExec();
  const app = await startApp({
    home,
    dataDir,
    createCore: async (o) => {
      const core = await createCore({ ...o, docker, start: { pollMs: 0, watch: false } });
      configureTestAccounts(core.server);
      return core;
    },
    version: VERSION,
    expectedEngineVersion: VERSION,
    execStart: "/usr/bin/aio-server",
    imageContext: path.join(home, "image"),
    runner: new FakeRunner(),
    op: {
      status: async () => ({ installed: false, version: null, signedIn: false, mode: "none" }),
      read: async () => "",
      listItems: async () => [],
    },
    exec,
    port: 0,
    linkPort: 0,
    linkHost: "127.0.0.1",
    linkAddress: "127.0.0.1",
    credentialPollMs: 0,
    linkTiming: { pingMs: 1000, timeoutMs: 5000, backoffMinMs: 50, backoffMaxMs: 200 },
    log: (m) => process.env.MH_DEBUG && console.error(`[${name}] ${m}`),
  });
  apps.push(app);
  const token = fs.readFileSync(path.join(dataDir, "server.token"), "utf8").trim();
  const pin = () => pinFromPem(fs.readFileSync(path.join(dataDir, "server.crt"), "utf8"));
  const fetchPinned = pinnedFetch(pin);
  return {
    app,
    home,
    exec,
    async api(method, url, body) {
      const res = await fetchPinned(`https://127.0.0.1:${app.port}${url}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    },
    async open(url) {
      const ws = new WebSocket(`wss://127.0.0.1:${app.port}${url}`, {
        ...pinnedTlsOptions(pin()),
        headers: { authorization: `Bearer ${token}` },
      });
      sockets.push(ws);
      const client: Client = {
        ws,
        texts: [],
        output: [],
        closed: new Promise((resolve) =>
          ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
        ),
        until: (predicate, timeoutMs = 5000) => waitFor(predicate, timeoutMs),
      };
      ws.on("message", (data, isBinary) => {
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
        if (isBinary) client.output.push(bytes);
        else client.texts.push(JSON.parse(bytes.toString()));
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
        ws.once("unexpected-response", (req, res) => {
          req.destroy();
          reject(new Error(`HTTP ${res.statusCode}`));
        });
      });
      return client;
    },
  };
}

/** Joins `node` to `hub` under `name` and waits for the link; resolves with the machine ID. */
async function join(hub: Server, node: Server, name: string): Promise<string> {
  const code = await hub.api("POST", "/api/v1/machines/enrollment-codes");
  expect(code.status).toBe(201);
  const joined = await node.api("POST", "/api/v1/node/join", {
    hubUrl: code.json.hubUrl,
    code: code.json.code,
    name,
  });
  expect(joined.status).toBe(200);
  const machineId = joined.json.machineId as string;
  await waitFor(() => hub.app.multiHost.links.get(machineId) !== undefined, 5000);
  await waitFor(() => node.app.multiHost.links.get("hub") !== undefined, 5000);
  return machineId;
}

/** Creates a running box on `server` and resolves with its view. */
async function createBox(server: Server): Promise<BoxView> {
  const dir = path.join(server.home, "work", "app");
  fs.mkdirSync(dir, { recursive: true });
  const created = await server.api("POST", "/api/v1/boxes", { targetDir: dir, layout: "root" });
  expect(created.status).toBe(202);
  let job = created.json;
  for (let i = 0; i < 200 && job.status !== "finished" && job.status !== "failed"; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    job = (await server.api("GET", `/api/v1/jobs/${created.json.id}`)).json;
  }
  expect(job).toMatchObject({ status: "finished", exitCode: 0 });
  const boxes = (await server.api("GET", "/api/v1/boxes")).json.boxes as unknown[];
  return BoxViewSchema.parse(boxes[0]);
}

function terminalUrl(machineId: string, box: BoxView, extra = "&cols=100&rows=30"): string {
  return `/api/v1/machines/${machineId}/proxy/terminals?kind=session&boxId=${box.box.id}${extra}`;
}

describe("terminal attach through the hub", () => {
  it("relays input, output, resize, and detach between a hub client and a node's box", async () => {
    const hub = await startServer("hub");
    const node = await startServer("node");
    const machineId = await join(hub, node, "node-one");
    const box = await createBox(node);

    const client = await hub.open(terminalUrl(machineId, box));
    await client.until(() => client.texts.length === 1);
    expect(client.texts[0]).toMatchObject({ type: "ready" });
    // The node runs the exec, with the size the client asked for; the hub runs none.
    expect(node.exec.requests).toHaveLength(1);
    expect(node.exec.requests[0]).toMatchObject({
      container: box.container,
      cmd: attachCmd(box.tmuxSession),
      cols: 100,
      rows: 30,
    });
    expect(hub.exec.requests).toHaveLength(0);

    // Output: binary frames arrive byte for byte, including bytes that aren't UTF-8.
    const container = node.exec.sessions[0]!.container;
    container.write(Buffer.from([0x1b, 0x5b, 0x48, 0xff, 0x00]));
    await client.until(() => Buffer.concat(client.output).length === 5);
    expect([...Buffer.concat(client.output)]).toEqual([0x1b, 0x5b, 0x48, 0xff, 0x00]);

    // Input: binary frames and `input` control frames reach the exec.
    const received: Buffer[] = [];
    container.on("data", (d: Buffer) => received.push(d));
    client.ws.send(Buffer.from([0x03, 0xfe]));
    client.ws.send(JSON.stringify({ type: "input", data: "ls\r" }));
    // Resize reaches the node's exec.
    client.ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await client.until(() => Buffer.concat(received).length === 5 && node.exec.sizes.length === 1);
    expect([...Buffer.concat(received)]).toEqual([0x03, 0xfe, ...Buffer.from("ls\r")]);
    expect(node.exec.sizes).toEqual([[120, 40]]);

    // Detach: the client closes, and the node closes its exec, which detaches
    // the tmux client and leaves the session running.
    client.ws.close(1000, "tab closed");
    await waitFor(() => node.exec.sessions[0]!.closed, 5000);
    expect(await client.closed).toMatchObject({ code: 1000 });

    // A second attach works over the same link.
    const again = await hub.open(terminalUrl(machineId, box));
    await again.until(() => again.texts.length === 1);
    expect(node.exec.requests).toHaveLength(2);
    again.ws.close();
    await waitFor(() => node.exec.sessions[1]!.closed, 5000);
  });

  it("passes the node's exit code and close to the client", async () => {
    const hub = await startServer("hub");
    const node = await startServer("node");
    const machineId = await join(hub, node, "node-one");
    const box = await createBox(node);
    const client = await hub.open(terminalUrl(machineId, box));
    await client.until(() => client.texts.length === 1);
    node.exec.sessions[0]!.exitCode = 3;
    node.exec.sessions[0]!.container.end();
    await client.until(() => client.texts.length === 2);
    expect(client.texts[1]).toEqual({ type: "exit", exitCode: 3 });
    expect(await client.closed).toEqual({ code: 1000, reason: "ended" });
  });

  it("refuses an attach to an unknown box with the node's error", async () => {
    const hub = await startServer("hub");
    const node = await startServer("node");
    const machineId = await join(hub, node, "node-one");
    const client = await hub.open(
      `/api/v1/machines/${machineId}/proxy/terminals?kind=session&boxId=nothing`,
    );
    await client.until(() => client.texts.length === 1);
    expect(client.texts[0]).toMatchObject({ type: "error", error: { code: "not_found" } });
    expect((await client.closed).code).toBe(1008);
    expect(node.exec.requests).toHaveLength(0);
  });

  it("closes the client with 1014 and closes the node's exec when the node goes offline", async () => {
    const hub = await startServer("hub");
    const node = await startServer("node");
    const machineId = await join(hub, node, "node-one");
    const box = await createBox(node);
    const client = await hub.open(terminalUrl(machineId, box));
    await client.until(() => client.texts.length === 1);

    // The link drops while the terminal is open.
    (hub.app.multiHost.links.get(machineId) as LinkPeer).close(1001, "test");
    const closed = await client.closed;
    expect(closed.code).toBe(1014);
    expect(closed.reason).toContain(machineId);
    // The node closes the exec, so no tmux client stays attached.
    await waitFor(() => node.exec.sessions[0]!.closed, 5000);

    // While the node is offline, a new attach fails before the upgrade.
    await node.app.close();
    apps.splice(apps.indexOf(node.app), 1);
    await waitFor(() => hub.app.multiHost.links.get(machineId) === undefined, 5000);
    await expect(hub.open(terminalUrl(machineId, box))).rejects.toThrow("HTTP 503");
  });

  it("holds a busy terminal back while the client doesn't read, without closing it", async () => {
    const hub = await startServer("hub");
    const node = await startServer("node");
    const machineId = await join(hub, node, "node-one");
    const box = await createBox(node);
    const client = await hub.open(terminalUrl(machineId, box));
    await client.until(() => client.texts.length === 1);
    let closedEarly = false;
    void client.closed.then(() => (closedEarly = true));

    // The client stops reading. The box prints until the node's exec stream
    // pushes back, which it must do long before the hub's relay limit.
    client.ws.pause();
    const container = node.exec.sessions[0]!.container;
    const size = 64 * 1024;
    let written = 0;
    const limit = 64 * 1024 * 1024;
    while (written < limit) {
      // Each chunk carries its number, so the client can check the order.
      const chunk = Buffer.alloc(size, (written / size) % 251);
      written += size;
      if (!container.write(chunk)) {
        // Give the relay a moment to drain what it can, then try again.
        const drained = await Promise.race([
          new Promise<boolean>((r) => container.once("drain", () => r(true))),
          new Promise<boolean>((r) => setTimeout(() => r(false), 500)),
        ]);
        if (!drained) break;
      }
    }
    expect(written).toBeLessThan(limit);
    expect(closedEarly).toBe(false);

    // A request on the same link still goes through while the terminal is held.
    const health = await hub.api("GET", `/api/v1/machines/${machineId}/proxy/health`);
    expect(health.status).toBe(200);

    // The client reads again and gets every byte, in order.
    client.ws.resume();
    await client.until(() => Buffer.concat(client.output).length === written, 20_000);
    const all = Buffer.concat(client.output);
    for (let i = 0; i < written / size; i += 1) {
      expect(all.subarray(i * size, (i + 1) * size).every((b) => b === i % 251)).toBe(true);
    }
    expect(closedEarly).toBe(false);
    client.ws.close();
  }, 30_000);

  it("refuses a terminal from one node to another node's box", async () => {
    const hub = await startServer("hub");
    const one = await startServer("one");
    const two = await startServer("two");
    const oneId = await join(hub, one, "node-one");
    await join(hub, two, "node-two");
    const box = await createBox(one);

    await expect(two.open(terminalUrl(oneId, box))).rejects.toThrow();
    expect(one.exec.requests).toHaveLength(0);
  });
});
