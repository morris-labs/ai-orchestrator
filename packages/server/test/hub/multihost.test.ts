// Two whole servers in one process, a hub and a node, each with its own
// temporary home and data directory passed as arguments: enrollment, the
// mutual TLS link, request and stream round trips, the secret relay,
// revocation, and protocol refusal.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineListSchema, NodeStatusSchema, type OpStatus } from "@aio/contracts";
import { pinFromPem, pinnedFetch, pinnedTlsOptions } from "@aio/contracts/tls";
import WebSocket from "ws";
import { startApp, type App } from "../../src/api/app.js";
import { ApiError } from "../../src/api/errors.js";
import { createCore } from "../../src/core.js";
import { Hub } from "../../src/hub/hub.js";
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
  options: {
    signedIn?: boolean;
    linkProtocol?: number;
    role?: "hub" | "node" | "both";
    before?: (home: string) => void;
    /** Replaces the fixed loopback link address of the other tests. */
    link?: { linkHost?: string; linkAddress?: string; lanAddress?: () => string | undefined };
  } = {},
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
    ...(options.link ?? { linkHost: "127.0.0.1", linkAddress: "127.0.0.1" }),
    linkProtocol: options.linkProtocol,
    role: options.role,
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

/** A sign-in sync entry for `text`, with its hash. */
function entryOf(key: string, text: string) {
  const bytes = Buffer.from(text);
  return {
    key,
    content: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
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

  it.each([
    ["holds invalid JSON", (file: string) => fs.writeFileSync(file, "{ not json")],
    ["can't be read", (file: string) => fs.mkdirSync(file)],
  ])("starts the hub when the node.json file %s", async (_name, damage) => {
    const hubStart = vi.spyOn(Hub.prototype, "start");
    try {
      const server = await startServer("damaged", {
        before: (home) => {
          const dir = path.join(home, "data", "link");
          fs.mkdirSync(dir, { recursive: true });
          for (const name of ["client.key", "client.crt", "hub-ca.crt", "hub.crt"]) {
            fs.writeFileSync(path.join(dir, name), "pem");
          }
          damage(path.join(dir, "node.json"));
        },
      });
      expect(hubStart).toHaveBeenCalledOnce();
      const status = NodeStatusSchema.parse((await server.api("GET", "/api/v1/node")).json);
      expect(status).toMatchObject({ link: "none", machineId: null });
    } finally {
      hubStart.mockRestore();
    }
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
    // 403, not 401: the local token is fine, and the CLI blames it on a 401.
    expect(reuse.status).toBe(403);
    expect(reuse.json.error.code).toBe("unauthorized");
    expect(reuse.json.error.message).toMatch(/Issue a new code on the hub/);
  });

  it("shows each machine's health on both ends", async () => {
    const { hub, node, joined } = await linkedPair();
    const machineId = joined.json.machineId as string;
    await waitFor(() => node.app.multiHost.status().link === "connected", 5000);
    await waitFor(() => hub.app.multiHost.links.get(machineId) !== undefined, 5000);

    const own = (await node.api("GET", "/api/v1/node/health")).json;
    expect(own).toMatchObject({ expectedEngineVersion: VERSION, image: "missing" });
    expect(own.diskTotalBytes).toBeGreaterThan(0);

    const onHub = MachineListSchema.parse((await hub.api("GET", "/api/v1/machines")).json);
    expect(onHub.machines.map((m) => [m.id, m.health?.image])).toEqual([
      ["local", "missing"],
      [machineId, "missing"],
    ]);
    expect(onHub.machines[1]?.health?.diskTotalBytes).toBe(own.diskTotalBytes);

    // The node shows the hub's health as the hub measured it.
    const onNode = MachineListSchema.parse((await node.api("GET", "/api/v1/machines")).json);
    expect(onNode.machines.find((m) => m.id === "hub")?.health).toMatchObject({
      image: "missing",
      expectedEngineVersion: VERSION,
    });

    // A revoked machine shows no health.
    await hub.api("DELETE", `/api/v1/machines/${machineId}`);
    const after = MachineListSchema.parse((await hub.api("GET", "/api/v1/machines")).json);
    expect(after.machines.find((m) => m.id === machineId)?.health).toBeNull();
  });

  it("binds the LAN address, refuses to listen without one, and lets linkHost win", async () => {
    // No LAN address: the hub refuses to listen rather than bind every interface.
    const bare = await startServer("bare", { link: { lanAddress: () => undefined } });
    const refused = await bare.api("POST", "/api/v1/machines/enrollment-codes");
    expect(refused.status).toBe(409);
    expect(refused.json.error.message).toMatch(/no LAN IPv4 address.*linkHost/);
    expect(bare.app.multiHost.hub.port).toBeNull();

    // An explicit linkHost setting wins, and the hub URL names the bound address.
    const patched = await bare.api("PATCH", "/api/v1/settings", { linkHost: "127.0.0.1" });
    expect(patched.status).toBe(200);
    const code = await bare.api("POST", "/api/v1/machines/enrollment-codes");
    expect(code.status).toBe(201);
    expect(code.json.hubUrl).toBe(`https://127.0.0.1:${bare.app.multiHost.hub.port}`);

    // The detected LAN address is the default bind, and linkAddress still names the hub.
    const lan = await startServer("lan", {
      link: { lanAddress: () => "127.0.0.1", linkAddress: "hub.example.com" },
    });
    const named = await lan.api("POST", "/api/v1/machines/enrollment-codes");
    expect(named.status).toBe(201);
    expect(named.json.hubUrl).toBe(`https://hub.example.com:${lan.app.multiHost.hub.port}`);
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

  it("refuses a join that comes over the link, whatever form the path takes", async () => {
    const { hub, node, joined } = await linkedPair();
    const machineId = joined.json.machineId as string;
    await waitFor(() => hub.app.multiHost.links.get(machineId) !== undefined, 5000);
    const toNode = hub.app.multiHost.links.get(machineId)!;
    const upstream = await startServer("upstream", { signedIn: true });
    const code = (await upstream.api("POST", "/api/v1/machines/enrollment-codes")).json;
    const before = node.app.multiHost.status().hubUrl;
    const body = Buffer.from(JSON.stringify({ hubUrl: code.hubUrl, code: code.code }));
    for (const path of [
      "/api/v1/node/join",
      "/api/v1/node/%6Aoin",
      "/api/v1/%6eode/join",
      "/api/v1/./node/join",
      "/api/v1/machines/local/proxy/node/join",
      `/api/v1/machines/${machineId}/proxy/node/join`,
      "/api/v1/machines/local/proxy/machines/local/proxy/node/join",
      "/api/v1/boxes/../node/join",
    ]) {
      const res = await toNode.request({
        method: "POST",
        path,
        headers: { "content-type": "application/json", "x-aio-link-caller": "" },
        body,
      });
      expect(res.status, path).toBe(403);
    }
    expect(node.app.multiHost.status().hubUrl).toBe(before);
    expect((await upstream.api("GET", "/api/v1/machines")).json.machines).toHaveLength(1);
    // A local client can still reach the route; only the link is refused.
    const local = await node.api("POST", "/api/v1/machines/local/proxy/node/join", {
      hubUrl: code.hubUrl,
      code: "0000-0000-0000-0000",
      replaceHub: true,
    });
    expect(local.json.error.message).toMatch(/hub refused the enrollment/);
  });

  it("drops the link when the role becomes hub, and starts it when the role changes back", async () => {
    const { hub, node, joined } = await linkedPair();
    const machineId = joined.json.machineId as string;
    await waitFor(() => node.app.multiHost.node.status().link === "connected");
    await waitFor(() => hub.app.multiHost.hub.get(machineId) !== undefined);

    expect((await node.api("PATCH", "/api/v1/settings", { role: "hub" })).status).toBe(200);
    expect(node.app.multiHost.node.status().link).toBe("none");
    await waitFor(() => hub.app.multiHost.hub.get(machineId) === undefined);
    // No retry brings it back while the role stays hub.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(hub.app.multiHost.hub.get(machineId)).toBeUndefined();

    expect((await node.api("PATCH", "/api/v1/settings", { role: "node" })).status).toBe(200);
    await waitFor(() => node.app.multiHost.node.status().link === "connected");
    await waitFor(() => hub.app.multiHost.hub.get(machineId) !== undefined);
  });

  it("refuses a second join without spending the code, until the caller replaces the hub", async () => {
    const { hub, node, code, joined } = await linkedPair();
    const other = await startServer("other-hub", { signedIn: true });
    const next = (await other.api("POST", "/api/v1/machines/enrollment-codes")).json;
    const linkFiles = () => fs.readFileSync(path.join(node.dataDir, "link", "client.key"), "utf8");
    const before = linkFiles();

    const refused = await node.api("POST", "/api/v1/node/join", {
      hubUrl: next.hubUrl,
      code: next.code,
      name: "node-one",
    });
    expect([refused.status, refused.json.error.code]).toEqual([409, "conflict"]);
    expect(refused.json.error.message).toContain(code.hubUrl);
    expect(refused.json.error.message).toMatch(/--replace-hub/);
    expect(linkFiles()).toBe(before);
    const status = (await node.api("GET", "/api/v1/node")).json;
    expect(status).toMatchObject({ hubUrl: code.hubUrl, machineId: joined.json.machineId });
    await waitFor(() => node.app.multiHost.status().link === "connected", 5000);
    expect((await hub.api("GET", "/api/v1/machines")).json.machines).toHaveLength(2);

    // The refusal left the code usable.
    const replaced = await node.api("POST", "/api/v1/node/join", {
      hubUrl: next.hubUrl,
      code: next.code,
      name: "node-one",
      replaceHub: true,
    });
    expect(replaced.status).toBe(200);
    expect(replaced.json.hubUrl).toBe(next.hubUrl);
    expect(linkFiles()).not.toBe(before);
    await waitFor(() => node.app.multiHost.status().link === "connected", 5000);
  });

  it("lets a revoked machine join again without replacing the hub", async () => {
    const { hub, node, joined } = await linkedPair();
    await waitFor(() => node.app.multiHost.status().link === "connected", 5000);
    await hub.api("DELETE", `/api/v1/machines/${joined.json.machineId}`);
    await waitFor(() => node.app.multiHost.status().link === "revoked", 5000);

    const next = (await hub.api("POST", "/api/v1/machines/enrollment-codes")).json;
    const again = await node.api("POST", "/api/v1/node/join", {
      hubUrl: next.hubUrl,
      code: next.code,
      name: "node-one",
    });
    expect(again.status).toBe(200);
    expect(again.json.machineId).not.toBe(joined.json.machineId);
  });

  it("lets one of two concurrent joins through", async () => {
    const hub = await startServer("hub", { signedIn: true });
    const other = await startServer("other-hub", { signedIn: true });
    const node = await startServer("node");
    const results = await Promise.all(
      [hub, other].map(async (target) => {
        const code = (await target.api("POST", "/api/v1/machines/enrollment-codes")).json;
        return node.api("POST", "/api/v1/node/join", {
          hubUrl: code.hubUrl,
          code: code.code,
          name: "node-one",
        });
      }),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.json.error.code).toBe("conflict");
  });

  it("reports a failure on the hub as unreachable, not as a refused code or token", async () => {
    const hub = await startServer("hub", { signedIn: true });
    const node = await startServer("node");
    const code = (await hub.api("POST", "/api/v1/machines/enrollment-codes")).json;
    const enroll = vi
      .spyOn(hub.app.multiHost.hub, "enroll")
      .mockRejectedValue(new ApiError("internal", "The hub's disk is full."));

    const res = await node.api("POST", "/api/v1/node/join", {
      hubUrl: code.hubUrl,
      code: code.code,
      name: "node-one",
    });
    enroll.mockRestore();
    expect([res.status, res.json.error.code]).toEqual([503, "hub_unreachable"]);
    expect(res.json.error.message).toMatch(/hub's disk is full/);
    expect((await node.api("GET", "/api/v1/node")).json.hubUrl).toBeNull();
  });

  it("reports a role override, and refuses a join under a hub override without storing a role", async () => {
    const hub = await startServer("hub", { signedIn: true });
    const code = (await hub.api("POST", "/api/v1/machines/enrollment-codes")).json;
    const pinned = await startServer("pinned", { role: "hub" });
    const status = NodeStatusSchema.parse((await pinned.api("GET", "/api/v1/node")).json);
    expect(status).toMatchObject({ role: "hub", roleOverride: "hub" });
    const res = await pinned.api("POST", "/api/v1/node/join", {
      hubUrl: code.hubUrl,
      code: code.code,
      leaveHubRole: true,
    });
    expect([res.status, res.json.error.code]).toEqual([409, "invalid_state"]);
    expect(res.json.error.message).toMatch(/--role hub/);
    expect((await pinned.api("GET", "/api/v1/settings")).json.role ?? "both").toBe("both");
    const plain = await startServer("plain");
    expect((await plain.api("GET", "/api/v1/node")).json).not.toHaveProperty("roleOverride");
  });

  it("joins from role hub only when asked, keeping the role until the join succeeds", async () => {
    const upstream = await startServer("upstream", { signedIn: true });
    const code = (await upstream.api("POST", "/api/v1/machines/enrollment-codes")).json;
    const former = await startServer("former");
    expect((await former.api("PATCH", "/api/v1/settings", { role: "hub" })).status).toBe(200);
    const body = { hubUrl: code.hubUrl, code: code.code };

    const refused = await former.api("POST", "/api/v1/node/join", body);
    expect([refused.status, refused.json.error.code]).toEqual([409, "invalid_state"]);

    // A failed join leaves the role alone.
    const wrong = await former.api("POST", "/api/v1/node/join", {
      ...body,
      code: "0000-0000-0000-0000",
      leaveHubRole: true,
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect((await former.api("GET", "/api/v1/settings")).json.role).toBe("hub");

    const joined = await former.api("POST", "/api/v1/node/join", { ...body, leaveHubRole: true });
    expect(joined.status).toBe(200);
    expect(joined.json).toMatchObject({ role: "node", hubUrl: code.hubUrl });
    expect((await former.api("GET", "/api/v1/settings")).json.role).toBe("node");
    // The link comes up without a server restart.
    await waitFor(() => former.app.multiHost.status().link === "connected", 5000);
  });

  it("refuses a join from role hub with enrolled machines, and never opens its boxes", async () => {
    const { hub, node } = await linkedPair();
    await waitFor(() => node.app.multiHost.status().link === "connected", 5000);
    expect((await hub.api("PATCH", "/api/v1/settings", { role: "hub" })).status).toBe(200);
    const upstream = await startServer("upstream", { signedIn: true });
    const code = (await upstream.api("POST", "/api/v1/machines/enrollment-codes")).json;
    const res = await hub.api("POST", "/api/v1/node/join", {
      hubUrl: code.hubUrl,
      code: code.code,
      leaveHubRole: true,
    });
    expect([res.status, res.json.error.code]).toEqual([409, "invalid_state"]);
    expect(res.json.error.message).toMatch(/enrolled machines/);
    expect(hub.app.multiHost.role()).toBe("hub");
    expect((await node.api("GET", "/api/v1/machines/hub/proxy/boxes")).status).toBe(403);
  });

  it("lets a node reach the boxes of a hub whose role is both, and not of a hub-only one", async () => {
    const { hub, node, joined } = await linkedPair();
    await waitFor(() => node.app.multiHost.status().link === "connected", 5000);
    const root = fs.realpathSync(tempDir("aio-mh-project-"));
    expect((await hub.api("POST", "/api/v1/projects", { root })).status).toBe(201);
    const via = (rest: string) => `/api/v1/machines/hub/proxy/${rest}`;

    // Role both: the box routes, projects, directories, and streams pass.
    const boxes = await node.api("GET", via("boxes"));
    expect(boxes.status).toBe(200);
    expect(boxes.json.boxes).toEqual([]);
    const projects = await node.api("GET", via("projects"));
    expect(projects.status).toBe(200);
    expect(
      projects.json.projects.map((p: { project: { root: string } }) => p.project.root),
    ).toEqual([root]);

    // Without a grant, directories, events, and terminals stay refused.
    const hello = { type: "hello", streamId: null, lastSeq: null };
    const toHub = node.app.multiHost.links.get("hub")!;
    expect(
      (await node.api("GET", `${via("fs/dirs")}?path=${encodeURIComponent(root)}`)).status,
    ).toBe(403);
    await expect(node.firstFrame(via("events"), hello)).rejects.toThrow();
    await expect(toHub.openStream({ path: "/api/v1/terminals", headers: {} })).rejects.toThrow(
      /doesn't serve/,
    );
    await expect(
      toHub.openStream({ path: via("terminals"), query: "kind=shell", headers: {} }),
    ).rejects.toThrow(/doesn't serve/);
    expect(
      (
        await hub.api("PATCH", "/api/v1/settings", {
          nodeGrants: { [joined.json.machineId as string]: { machineAccess: ["hub"] } },
        })
      ).status,
    ).toBe(200);

    expect(
      (await node.api("GET", `${via("fs/dirs")}?path=${encodeURIComponent(root)}`)).status,
    ).toBe(200);
    for (const action of ["start", "stop", "restart"]) {
      const res = await node.api("POST", via(`boxes/no-such-box/${action}`));
      expect([res.status, res.json.error.code]).toEqual([404, "not_found"]);
    }
    expect((await node.api("GET", via("boxes/no-such-box"))).status).toBe(404);
    const hubStream = await hub.firstFrame("/api/v1/events", hello);
    const relayed = await node.firstFrame(via("events"), hello);
    expect(relayed).toMatchObject({ type: "hello", streamId: hubStream.streamId });
    // The hub serves the terminal upgrade; the terminal itself answers
    // the attach message, which this test doesn't send.
    const terminal = await toHub.openStream({ path: "/api/v1/terminals", headers: {} });
    terminal.close(1000, "done");

    // Everything else stays refused.
    for (const [method, rest, body] of [
      ["GET", "settings"],
      ["PATCH", "settings", { linkPort: 1 }],
      ["GET", "secrets/available"],
      ["GET", "accounts"],
      ["POST", "machines/enrollment-codes"],
      ["GET", "node"],
      ["POST", "boxes", {}],
      ["DELETE", "boxes/no-such-box"],
      ["POST", "projects", { root }],
    ] as [string, string, unknown?][]) {
      expect((await node.api(method, via(rest), body)).status, `${method} ${rest}`).toBe(403);
    }

    // Role hub: back to the machine list and health only.
    expect((await hub.api("PATCH", "/api/v1/settings", { role: "hub" })).status).toBe(200);
    expect((await node.api("GET", via("boxes"))).status).toBe(403);
    expect((await node.api("GET", via("projects"))).status).toBe(403);
    expect((await node.api("POST", via("boxes/no-such-box/start"))).status).toBe(403);
    await expect(node.firstFrame(via("events"), hello)).rejects.toThrow();
    await expect(toHub.openStream({ path: "/api/v1/terminals", headers: {} })).rejects.toThrow(
      /doesn't serve/,
    );
    expect((await node.api("GET", via("health"))).status).toBe(200);
    expect((await node.api("GET", via("machines"))).status).toBe(200);
  });

  it("resolves a node's secrets through the hub", async () => {
    const { hub, node, joined } = await linkedPair();
    await waitFor(() => node.app.multiHost.links.get("hub") !== undefined, 5000);
    const op = node.app.multiHost.op;
    expect(await op.status()).toMatchObject({ signedIn: true, mode: "service_account" });

    // A machine with no grant reads and lists nothing.
    await expect(op.read("op://Vault/item/field")).rejects.toMatchObject({
      code: "secrets_unavailable",
      message: expect.stringContaining("nodeGrants"),
    });
    await expect(op.listItems("Vault")).rejects.toMatchObject({ code: "secrets_unavailable" });
    expect(hub.op.reads).toEqual([]);

    const machineId = joined.json.machineId as string;
    const granted = await hub.api("PATCH", "/api/v1/settings", {
      nodeGrants: { [machineId]: { opRefs: ["op://Vault/item/field"], opVaults: ["Vault"] } },
    });
    expect(granted.status).toBe(200);
    expect(await op.read("op://Vault/item/field")).toBe(SECRET);
    expect(await op.listItems("Vault")).toEqual([]);
    expect(hub.op.reads).toEqual(["op://Vault/item/field"]);

    // The grant names exact references and vaults, and never its neighbours.
    for (const ref of ["op://Vault/item/other", "op://Vault/item/field?attribute=otp"]) {
      await expect(op.read(ref)).rejects.toMatchObject({ code: "secrets_unavailable" });
    }
    await expect(op.listItems("Other")).rejects.toMatchObject({ code: "secrets_unavailable" });
    expect(hub.op.reads).toEqual(["op://Vault/item/field"]);

    // A request outside the grant answers 403 on the link itself.
    const refused = await node.app.multiHost.links.get("hub")!.request({
      method: "POST",
      path: "/link/v1/op/read",
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ ref: "op://Vault/item/other" })),
    });
    expect(refused.status).toBe(403);
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
    expect(wrong.status).toBe(403);
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
    await waitFor(() => one.app.multiHost.status().link === "connected", 5000);
    await waitFor(() => two.app.multiHost.status().link === "connected", 5000);
    const key = "host/claude/.credentials.json";
    const [idOne, idTwo] = ids as [string, string];

    // With no grant, the hub copies nothing and takes nothing.
    const pull = (s: Server) =>
      s.app.multiHost.links
        .get("hub")!
        .request({ method: "POST", path: "/link/v1/credentials/pull", headers: {} });
    expect(JSON.parse((await pull(one)).body.toString())).toEqual({ entries: [] });
    const push = await one.app.multiHost.links.get("hub")!.request({
      method: "POST",
      path: "/link/v1/credentials/push",
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(entryOf(key, '{"token":"forged"}'))),
    });
    expect(push.status).toBe(403);
    expect(read(hub)).toBe('{"token":"synthetic-1"}');
    expect(read(one)).toBeNull();
    expect(read(two)).toBeNull();

    const patched = await hub.api("PATCH", "/api/v1/settings", {
      nodeGrants: {
        [idOne]: { signInCopies: [key], signInUpdates: [key] },
        [idTwo]: { signInCopies: [key] },
      },
    });
    expect(patched.status).toBe(200);
    one.app.multiHost.node.restart();
    two.app.multiHost.node.restart();
    await waitFor(() => read(one) === '{"token":"synthetic-1"}' && read(two) === read(one), 5000);
    expect(fs.statSync(credFile(one.home)).mode & 0o777).toBe(0o600);

    // A copy grant doesn't let a machine overwrite the file for anyone else.
    fs.writeFileSync(credFile(two.home), '{"token":"forged"}');
    await two.app.multiHost.syncCredentials();
    expect(read(hub)).toBe('{"token":"synthetic-1"}');
    expect(read(one)).toBe('{"token":"synthetic-1"}');
    fs.writeFileSync(credFile(two.home), '{"token":"synthetic-1"}');
    await two.app.multiHost.syncCredentials();

    // Node one's CLI refreshes its token.
    fs.writeFileSync(credFile(one.home), '{"token":"synthetic-2"}');
    await one.app.multiHost.syncCredentials();
    await waitFor(() => read(hub) === '{"token":"synthetic-2"}' && read(two) === read(hub), 5000);

    // The hub refreshes its own.
    fs.writeFileSync(credFile(hub.home), '{"token":"synthetic-3"}');
    await hub.app.multiHost.syncCredentials();
    await waitFor(() => read(one) === '{"token":"synthetic-3"}' && read(two) === read(one), 5000);

    // The hub doesn't send a file to a machine whose grant no longer lists it.
    await hub.api("PATCH", "/api/v1/settings", {
      nodeGrants: { [idOne]: { signInCopies: [key] } },
    });
    fs.writeFileSync(credFile(hub.home), '{"token":"synthetic-4"}');
    await hub.app.multiHost.syncCredentials();
    await waitFor(() => read(one) === '{"token":"synthetic-4"}', 5000);
    expect(read(two)).toBe('{"token":"synthetic-3"}');
    const cleared = await hub.api("PATCH", "/api/v1/settings", { nodeGrants: null });
    expect(cleared.json.nodeGrants).toBeUndefined();
    expect(JSON.parse((await pull(one)).body.toString())).toEqual({ entries: [] });
  });

  it("delivers a sign-in change despite a pull, a refusal, or a failed send", async () => {
    const key = "host/claude/.credentials.json";
    const claudeDir = (s: Server) => path.join(s.home, ".claude");
    const file = (s: Server) => path.join(claudeDir(s), ".credentials.json");
    const read = (s: Server) => fs.readFileSync(file(s), "utf8");
    const hub = await startServer("hub", {
      signedIn: true,
      before: (home) => {
        fs.mkdirSync(path.join(home, ".claude"));
        fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"token":"v1"}');
      },
    });
    const withDir = (home: string) => fs.mkdirSync(path.join(home, ".claude"));
    const one = await startServer("one", { before: withDir });
    const two = await startServer("two", { before: withDir });
    const ids: string[] = [];
    for (const node of [one, two]) {
      const code = (await hub.api("POST", "/api/v1/machines/enrollment-codes")).json;
      const joined = await node.api("POST", "/api/v1/node/join", {
        hubUrl: code.hubUrl,
        code: code.code,
        name: `node-${node === one ? "one" : "two"}`,
      });
      ids.push(joined.json.machineId as string);
    }
    const [idOne, idTwo] = ids as [string, string];
    await hub.api("PATCH", "/api/v1/settings", {
      nodeGrants: { [idOne]: { signInCopies: [key] }, [idTwo]: { signInCopies: [key] } },
    });
    one.app.multiHost.node.restart();
    two.app.multiHost.node.restart();
    await waitFor(() => fs.existsSync(file(one)) && fs.existsSync(file(two)), 5000);
    await waitFor(() => one.app.multiHost.status().link === "connected", 5000);
    await waitFor(() => two.app.multiHost.status().link === "connected", 5000);

    // A hub-side change survives a node's pull before the next check.
    fs.writeFileSync(file(hub), '{"token":"v2"}');
    const pulled = await one.app.multiHost.links
      .get("hub")!
      .request({ method: "POST", path: "/link/v1/credentials/pull", headers: {} });
    expect(pulled.status).toBe(200);
    await hub.app.multiHost.syncCredentials();
    await waitFor(() => read(two) === '{"token":"v2"}', 5000);

    // A node that the hub refused keeps its rotated token through a relink, and
    // sends it once the grant allows that.
    fs.writeFileSync(file(one), '{"token":"rotated"}');
    await one.app.multiHost.syncCredentials();
    expect(read(hub)).toBe('{"token":"v2"}');
    const hubLink = one.app.multiHost.links.get("hub");
    one.app.multiHost.node.restart();
    await waitFor(() => {
      const link = one.app.multiHost.links.get("hub");
      return link !== undefined && link !== hubLink;
    }, 5000);
    // The second check runs after the pull that the link-up queued.
    await one.app.multiHost.syncCredentials();
    await one.app.multiHost.syncCredentials();
    expect(read(one)).toBe('{"token":"rotated"}');
    await hub.api("PATCH", "/api/v1/settings", {
      nodeGrants: {
        [idOne]: { signInCopies: [key], signInUpdates: [key] },
        [idTwo]: { signInCopies: [key] },
      },
    });
    await one.app.multiHost.syncCredentials();
    await waitFor(() => read(hub) === '{"token":"rotated"}', 5000);
    await waitFor(() => read(two) === '{"token":"rotated"}', 5000);

    // A hub that can't write to a node sends the file again on a later check.
    fs.chmodSync(claudeDir(two), 0o555);
    try {
      fs.writeFileSync(file(hub), '{"token":"v3"}');
      await hub.app.multiHost.syncCredentials();
      expect(read(two)).toBe('{"token":"rotated"}');
    } finally {
      fs.chmodSync(claudeDir(two), 0o755);
    }
    await hub.app.multiHost.syncCredentials();
    await waitFor(() => read(two) === '{"token":"v3"}', 5000);

    // A bad entry from a granted node changes nothing.
    const bad = await one.app.multiHost.links.get("hub")!.request({
      method: "POST",
      path: "/link/v1/credentials/push",
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ ...entryOf(key, '{"token":"x"}'), content: "" })),
    });
    expect(bad.status).toBe(400);
    expect(read(hub)).toBe('{"token":"v3"}');
  });

  it("gives no session cookie over a link, whatever form the path takes", async () => {
    const { hub, joined } = await linkedPair();
    const machineId = joined.json.machineId as string;
    await waitFor(() => hub.app.multiHost.links.get(machineId) !== undefined, 5000);
    const toNode = hub.app.multiHost.links.get(machineId)!;
    for (const path of [
      "/api/v1/auth/session",
      "/api/v1/auth/%73ession",
      "/api/v1/machines/local/proxy/auth/session",
    ]) {
      const res = await toNode.request({ method: "POST", path, headers: {} });
      expect(res.status, path).toBe(403);
      expect(res.headers["set-cookie"], path).toBeUndefined();
    }
  });
});
