// Two whole servers in one process, a hub and a node, each with its own
// temporary home and data directory passed as arguments: enrollment, the
// mutual TLS link, request and stream round trips, the secret relay,
// revocation, and protocol refusal.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MachineListSchema, NodeStatusSchema, type OpStatus } from "@aio/contracts";
import { pinFromPem, pinnedFetch, pinnedTlsOptions } from "@aio/contracts/tls";
import WebSocket from "ws";
import { startApp, type App } from "../../src/api/app.js";
import { createCore } from "../../src/core.js";
import { MemoryDocker } from "../../src/docker/memory.js";
import type { OpClient } from "../../src/secrets/op.js";
import { waitFor } from "../events/fake-engine.js";
import { FakeRunner } from "../setup/fake-runner.js";
import { FakeExec } from "../api/harness.js";
import { tempDir } from "../tmp.js";

const VERSION = "1.0.0-test";
const SECRET = "synthetic-secret-value";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies the tests index freely
type Json = any;

const apps: App[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** A 1Password double that resolves every reference to `SECRET` and counts reads. */
function fakeOp(signedIn: boolean): OpClient & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    status: async (): Promise<OpStatus> => ({
      installed: signedIn,
      version: signedIn ? "2.30.0" : null,
      signedIn,
      mode: signedIn ? "service_account" : "none",
    }),
    read: async (ref) => {
      reads.push(ref);
      if (!signedIn) throw new Error("This machine has no 1Password token.");
      return SECRET;
    },
    listItems: async () => [],
  };
}

interface Server {
  app: App;
  home: string;
  dataDir: string;
  op: ReturnType<typeof fakeOp>;
  /** Opens a WebSocket to `url` on this server and resolves with its first text frame. */
  firstFrame(url: string, send: unknown): Promise<Json>;
  api(method: string, url: string, body?: unknown): Promise<{ status: number; json: Json }>;
}

async function startServer(
  name: string,
  options: { signedIn?: boolean; linkProtocol?: number; before?: (home: string) => void } = {},
): Promise<Server> {
  const home = fs.realpathSync(tempDir(`aio-mh-${name}-`));
  options.before?.(home);
  const dataDir = path.join(home, "data");
  const op = fakeOp(options.signedIn ?? false);
  const docker = new MemoryDocker();
  const app = await startApp({
    home,
    dataDir,
    createCore: (o) => createCore({ ...o, docker, start: { pollMs: 0, watch: false } }),
    version: VERSION,
    expectedEngineVersion: VERSION,
    execStart: "/usr/bin/aio-server",
    imageContext: path.join(home, "image"),
    runner: new FakeRunner(),
    op,
    exec: new FakeExec(),
    port: 0,
    linkPort: 0,
    linkHost: "127.0.0.1",
    linkAddress: "127.0.0.1",
    linkProtocol: options.linkProtocol,
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
    dataDir,
    op,
    firstFrame(url, send) {
      const ws = new WebSocket(`wss://127.0.0.1:${app.port}${url}`, {
        ...pinnedTlsOptions(pin()),
        headers: { authorization: `Bearer ${token}` },
      });
      return new Promise((resolve, reject) => {
        ws.once("open", () => ws.send(JSON.stringify(send)));
        ws.once("message", (data) => {
          resolve(JSON.parse(data.toString()));
          ws.close(1000);
        });
        ws.once("error", reject);
        ws.once("unexpected-response", (_req, res) =>
          reject(new Error(`The upgrade got HTTP ${res.statusCode}.`)),
        );
      });
    },
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
  };
}

/** Starts a hub and a node, and joins the node to the hub. */
async function linkedPair(nodeOptions: { linkProtocol?: number } = {}) {
  const hub = await startServer("hub", { signedIn: true });
  const node = await startServer("node", nodeOptions);
  const code = await hub.api("POST", "/api/v1/machines/enrollment-codes");
  expect(code.status).toBe(201);
  const joined = await node.api("POST", "/api/v1/node/join", {
    hubUrl: code.json.hubUrl,
    code: code.json.code,
    name: "node-one",
  });
  return { hub, node, code: code.json, joined };
}

describe("multi-host", () => {
  it("behaves like a single machine by default, with no link listener", async () => {
    const solo = await startServer("solo");
    const status = NodeStatusSchema.parse((await solo.api("GET", "/api/v1/node")).json);
    expect(status).toMatchObject({ role: "both", link: "none", linkPort: null, machineId: null });
    const list = MachineListSchema.parse((await solo.api("GET", "/api/v1/machines")).json);
    expect(list.machines).toHaveLength(1);
    expect(list.machines[0]).toMatchObject({ id: "local", isLocal: true, status: "online" });
    expect(fs.existsSync(path.join(solo.dataDir, "hub"))).toBe(false);
  });

  it("enrolls a node, links over mutual TLS, and lists machines on both ends", async () => {
    const { hub, node, code, joined } = await linkedPair();
    expect(code.hubUrl).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    expect(code.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(joined.status).toBe(200);
    expect(joined.json).toMatchObject({ role: "node", name: "node-one" });
    const machineId = joined.json.machineId as string;

    // The CA key and the node's client key are private.
    expect(fs.statSync(path.join(hub.dataDir, "hub", "ca.key")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(node.dataDir, "link", "client.key")).mode & 0o777).toBe(0o600);

    await waitFor(() => hub.app.multiHost.links.get(machineId) !== undefined, 5000);
    await waitFor(() => node.app.multiHost.status().link === "connected", 5000);
    expect(node.app.multiHost.links.list()).toEqual(["hub"]);

    const onHub = MachineListSchema.parse((await hub.api("GET", "/api/v1/machines")).json);
    expect(onHub.machines.map((m) => [m.id, m.status, m.isLocal])).toEqual([
      ["local", "online", true],
      [machineId, "online", false],
    ]);
    expect(onHub.machines[1]).toMatchObject({
      name: "node-one",
      role: "node",
      protocol: 1,
      serverVersion: VERSION,
    });

    const onNode = MachineListSchema.parse((await node.api("GET", "/api/v1/machines")).json);
    expect(onNode.machines.map((m) => [m.id, m.isLocal])).toEqual([
      ["local", true],
      ["hub", false],
    ]);
    expect(onNode.machines[0]).toMatchObject({ name: "node-one", role: "node" });

    // A code works once.
    const again = await startServer("other");
    const reuse = await again.api("POST", "/api/v1/node/join", {
      hubUrl: code.hubUrl,
      code: code.code,
      name: "node-two",
    });
    expect(reuse.status).toBe(401);
    expect(reuse.json.error.code).toBe("unauthorized");
  });

  it("round-trips requests both ways and limits what a node may call on the hub", async () => {
    const { hub, node, joined } = await linkedPair();
    const machineId = joined.json.machineId as string;
    await waitFor(() => hub.app.multiHost.links.get(machineId) !== undefined, 5000);
    await waitFor(() => node.app.multiHost.links.get("hub") !== undefined, 5000);

    const toNode = hub.app.multiHost.links.get(machineId)!;
    const health = await toNode.request({ method: "GET", path: "/api/v1/health", headers: {} });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body.toString())).toMatchObject({ version: VERSION });
    // The hub reaches authenticated routes as a trusted caller.
    const settings = await toNode.request({
      method: "GET",
      path: "/api/v1/settings",
      headers: { authorization: "Bearer wrong" },
    });
    expect(settings.status).toBe(200);
    expect(JSON.parse(settings.body.toString()).role).toBe("node");

    const toHub = node.app.multiHost.links.get("hub")!;
    const machines = await toHub.request({ method: "GET", path: "/api/v1/machines", headers: {} });
    expect(machines.status).toBe(200);
    const refused = await toHub.request({ method: "GET", path: "/api/v1/settings", headers: {} });
    expect(refused.status).toBe(403);
  });

  it("round-trips a stream into the other end's WebSocket routes", async () => {
    const { hub, joined } = await linkedPair();
    const machineId = joined.json.machineId as string;
    await waitFor(() => hub.app.multiHost.links.get(machineId) !== undefined, 5000);
    const stream = await hub.app.multiHost.links
      .get(machineId)!
      .openStream({ path: "/api/v1/events", headers: {} });
    const frames: unknown[] = [];
    stream.onMessage((data, binary) => {
      expect(binary).toBe(false);
      frames.push(JSON.parse(data.toString()));
    });
    stream.send(JSON.stringify({ type: "hello", streamId: null, lastSeq: null }), false);
    await waitFor(() => frames.length > 0, 5000);
    expect(frames[0]).toMatchObject({ type: "hello" });
    let closed: number | null = null;
    stream.onClose((code) => {
      closed = code;
    });
    stream.close(1000, "done");
    expect(closed).toBe(1000);

    await expect(
      hub.app.multiHost.links.get(machineId)!.openStream({ path: "/api/v1/nowhere", headers: {} }),
    ).rejects.toThrow(/refused the stream/);
  });

  it("routes the machine proxy route over the real link in both directions", async () => {
    const { hub, node, joined } = await linkedPair();
    const machineId = joined.json.machineId as string;
    await waitFor(() => hub.app.multiHost.links.get(machineId) !== undefined, 5000);
    await waitFor(() => node.app.multiHost.links.get("hub") !== undefined, 5000);

    // The hub's own machine resolves locally, by "local" and by "hub".
    for (const id of ["local", "hub"]) {
      const own = await hub.api("GET", `/api/v1/machines/${id}/proxy/settings`);
      expect(own.status).toBe(200);
      expect(own.json.role ?? "both").toBe("both");
    }

    // (a) HTTP from the hub to the node.
    const health = await hub.api("GET", `/api/v1/machines/${machineId}/proxy/health`);
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({ version: VERSION });
    const settings = await hub.api("GET", `/api/v1/machines/${machineId}/proxy/settings`);
    expect(settings.status).toBe(200);
    expect(settings.json.role).toBe("node");

    // (b) A WebSocket from the hub to the node's event stream: its hello
    // carries the node's stream id, not the hub's.
    const hello = { type: "hello", streamId: null, lastSeq: null };
    const direct = await node.firstFrame("/api/v1/events", hello);
    const relayed = await hub.firstFrame(`/api/v1/machines/${machineId}/proxy/events`, hello);
    expect(relayed).toMatchObject({ type: "hello", streamId: direct.streamId });
    const hubOwn = await hub.firstFrame("/api/v1/events", hello);
    expect(hubOwn.streamId).not.toBe(direct.streamId);

    // (c) From the node, the hub's health and machine list through the hub's ID.
    const hubHealth = await node.api("GET", "/api/v1/machines/hub/proxy/health");
    expect(hubHealth.status).toBe(200);
    expect(hubHealth.json).toMatchObject({ version: VERSION });
    const viaHub = await node.api("GET", "/api/v1/machines/hub/proxy/machines");
    expect(viaHub.status).toBe(200);
    expect(MachineListSchema.parse(viaHub.json).machines.map((m) => m.id)).toEqual([
      "local",
      machineId,
    ]);
    // The node's own enrolled ID and "local" stay on the node.
    for (const id of ["local", machineId]) {
      const own = await node.api("GET", `/api/v1/machines/${id}/proxy/settings`);
      expect(own.status).toBe(200);
      expect(own.json.role).toBe("node");
    }
    // The hub still refuses a path that defaultAllowNodeRequest doesn't allow.
    const refused = await node.api("GET", "/api/v1/machines/hub/proxy/settings");
    expect(refused.status).toBe(403);
  });

  it("resolves a node's secrets through the hub", async () => {
    const { hub, node } = await linkedPair();
    await waitFor(() => node.app.multiHost.links.get("hub") !== undefined, 5000);
    const op = node.app.multiHost.op;
    expect(await op.status()).toMatchObject({ signedIn: true, mode: "service_account" });
    expect(await op.read("op://Vault/item/field")).toBe(SECRET);
    expect(hub.op.reads).toEqual(["op://Vault/item/field"]);
    expect(node.op.reads).toEqual([]);
    await expect(op.read("not-a-reference")).rejects.toMatchObject({ code: "validation" });

    // With the hub gone, the relay fails cleanly.
    await hub.app.close();
    apps.splice(apps.indexOf(hub.app), 1);
    await waitFor(() => node.app.multiHost.links.get("hub") === undefined, 5000);
    await expect(op.read("op://Vault/item/field")).rejects.toMatchObject({
      code: "secrets_unavailable",
    });
    const list = MachineListSchema.parse((await node.api("GET", "/api/v1/machines")).json);
    expect(list.machines.find((m) => m.id === "hub")?.status).toBe("offline");
  });

  it("revokes a machine, closes its link, and refuses it afterwards", async () => {
    const { hub, node, joined } = await linkedPair();
    const machineId = joined.json.machineId as string;
    await waitFor(() => node.app.multiHost.status().link === "connected", 5000);
    const revoked = await hub.api("DELETE", `/api/v1/machines/${machineId}`);
    expect(revoked.status).toBe(200);
    await waitFor(() => node.app.multiHost.status().link === "revoked", 5000);
    expect(hub.app.multiHost.links.get(machineId)).toBeUndefined();
    const list = MachineListSchema.parse((await hub.api("GET", "/api/v1/machines")).json);
    expect(list.machines.find((m) => m.id === machineId)?.status).toBe("revoked");

    // A restarted link is refused with 403.
    node.app.multiHost.node.restart();
    await waitFor(() => node.app.multiHost.status().link === "revoked", 5000);
    expect(node.app.multiHost.status().error).toMatch(/revoked/);

    expect((await hub.api("DELETE", "/api/v1/machines/mnothing")).status).toBe(404);
    expect((await node.api("POST", "/api/v1/machines/enrollment-codes")).status).toBe(409);
  });

  it("refuses a link between different protocol major versions", async () => {
    const { node } = await linkedPair({ linkProtocol: 2 });
    await waitFor(() => node.app.multiHost.status().link === "refused", 5000);
    expect(node.app.multiHost.status().error).toMatch(/protocol versions differ/);
    expect(node.app.multiHost.links.get("hub")).toBeUndefined();
  });

  it("refuses a wrong code and a taken name", async () => {
    const { hub, code } = await linkedPair();
    const other = await startServer("other");
    const wrong = await other.api("POST", "/api/v1/node/join", {
      hubUrl: code.hubUrl,
      code: "0000-0000-0000-0000",
      name: "node-two",
    });
    expect(wrong.status).toBe(401);
    const fresh = await hub.api("POST", "/api/v1/machines/enrollment-codes");
    const taken = await other.api("POST", "/api/v1/node/join", {
      hubUrl: fresh.json.hubUrl,
      code: fresh.json.code,
      name: "node-one",
    });
    expect(taken.status).toBe(409);
    expect(taken.json.error.code).toBe("conflict");
  });

  it("copies sign-ins from the hub and sends a node's refresh to the other nodes", async () => {
    const claudeDir = (home: string) => path.join(home, ".claude");
    const credFile = (home: string) => path.join(claudeDir(home), ".credentials.json");
    const hub = await startServer("hub", {
      signedIn: true,
      before: (home) => {
        fs.mkdirSync(claudeDir(home));
        fs.writeFileSync(credFile(home), '{"token":"synthetic-1"}');
      },
    });
    const withDir = (home: string) => fs.mkdirSync(claudeDir(home));
    const one = await startServer("one", { before: withDir });
    const two = await startServer("two", { before: withDir });
    const ids: string[] = [];
    for (const [node, name] of [
      [one, "node-one"],
      [two, "node-two"],
    ] as const) {
      const code = (await hub.api("POST", "/api/v1/machines/enrollment-codes")).json;
      const joined = await node.api("POST", "/api/v1/node/join", {
        hubUrl: code.hubUrl,
        code: code.code,
        name,
      });
      ids.push(joined.json.machineId as string);
    }
    const read = (s: Server) =>
      fs.existsSync(credFile(s.home)) ? fs.readFileSync(credFile(s.home), "utf8") : null;
    await waitFor(() => read(one) === '{"token":"synthetic-1"}' && read(two) === read(one), 5000);
    expect(fs.statSync(credFile(one.home)).mode & 0o777).toBe(0o600);

    // Node one's CLI refreshes its token.
    fs.writeFileSync(credFile(one.home), '{"token":"synthetic-2"}');
    await one.app.multiHost.syncCredentials();
    await waitFor(() => read(hub) === '{"token":"synthetic-2"}' && read(two) === read(hub), 5000);

    // The hub refreshes its own.
    fs.writeFileSync(credFile(hub.home), '{"token":"synthetic-3"}');
    await hub.app.multiHost.syncCredentials();
    await waitFor(() => read(one) === '{"token":"synthetic-3"}' && read(two) === read(one), 5000);
  });
});
