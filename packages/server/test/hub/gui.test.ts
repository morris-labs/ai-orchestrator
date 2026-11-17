import { configureTestAccounts } from "../account-fixture.js";
// The hub's GUI listener, end to end: whole servers in one process, a hub and a
// node over the real mutual TLS link, and a GUI app's side from the code the
// Electron main process runs: enrollment and the loopback proxy.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import path from "node:path";
import tls from "node:tls";
import { GUI_ENROLL_PATH, guiClientProof, guiCodeKey } from "@aio/contracts/gui-enroll";
import { pinFromPem, pinnedFetch } from "@aio/contracts/tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  enrollWithHub,
  readConnection,
  startHubProxy,
  type HubEnrollment,
  type HubProxy,
} from "@aio/contracts/gui-client";
import { startApp, type App } from "../../src/api/app.js";
import { createCore } from "../../src/core.js";
import { MemoryDocker } from "../../src/docker/memory.js";
import {
  issueGuiCertificate,
  issueNodeCertificate,
  loadOrCreateHubIdentity,
  newNodeKey,
} from "../../src/hub/ca.js";
import { WsStream } from "../../src/hub/dispatch.js";
import { waitFor } from "../events/fake-engine.js";
import { FakeExec } from "../api/harness.js";
import { FakeRunner } from "../setup/fake-runner.js";
import { tempDir } from "../tmp.js";

const VERSION = "1.0.0-test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies the tests index freely
type Json = any;

const apps: App[] = [];
const proxies: HubProxy[] = [];
const sockets: WebSocket[] = [];
const hubs: https.Server[] = [];
const hubSockets: Duplex[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const proxy of proxies.splice(0)) await proxy.close();
  for (const app of apps.splice(0)) await app.close();
  for (const socket of hubSockets.splice(0)) socket.destroy();
  for (const hub of hubs.splice(0)) {
    hub.closeAllConnections();
    await new Promise((resolve) => hub.close(resolve));
  }
});

interface Server {
  app: App;
  home: string;
  dataDir: string;
  exec: FakeExec;
  api(method: string, url: string, body?: unknown): Promise<{ status: number; json: Json }>;
}

async function startServer(name: string): Promise<Server> {
  const home = fs.realpathSync(tempDir(`aio-gui-${name}-`));
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
    guiPort: 0,
    linkHost: "127.0.0.1",
    linkAddress: "127.0.0.1",
    credentialPollMs: 0,
    linkTiming: { pingMs: 1000, timeoutMs: 5000, backoffMinMs: 50, backoffMaxMs: 200 },
    log: () => undefined,
  });
  apps.push(app);
  const token = fs.readFileSync(path.join(dataDir, "server.token"), "utf8").trim();
  const pin = () => pinFromPem(fs.readFileSync(path.join(dataDir, "server.crt"), "utf8"));
  const fetchPinned = pinnedFetch(pin);
  return {
    app,
    home,
    dataDir,
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
  };
}

/** One HTTPS call to the listener, with the given client certificate. */
function call(
  hubUrl: string,
  urlPath: string,
  identity: { key: string; cert: string } | null,
  options: { method?: string; body?: string } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${hubUrl}${urlPath}`,
      {
        method: options.method ?? "GET",
        rejectUnauthorized: false,
        agent: false,
        ...(identity ?? {}),
        headers: options.body ? { "content-type": "application/json" } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

async function enrolled(hub: Server, name = "desk-pc") {
  const code = (await hub.api("POST", "/api/v1/gui-clients/enrollment-codes")).json;
  const dir = path.join(hub.home, `client-${name}`);
  const enrollment = await enrollWithHub(dir, { hubUrl: code.hubUrl, code: code.code, name });
  return { code, dir, enrollment };
}

const identityOf = (e: HubEnrollment) => ({ key: e.clientKey, cert: e.clientCert });

describe("the GUI listener", () => {
  it("stays off until a code is issued, and turns off with the last GUI app", async () => {
    const hub = await startServer("hub");
    expect(hub.app.multiHost.gui.port).toBeNull();
    const { enrollment } = await enrolled(hub);
    expect(hub.app.multiHost.gui.port).not.toBeNull();
    await hub.api("DELETE", `/api/v1/gui-clients/${enrollment.clientId}`);
    expect(hub.app.multiHost.gui.port).toBeNull();
  });

  it("keeps the private key on the app's side, with mode 0600", async () => {
    const hub = await startServer("hub");
    const { dir, enrollment } = await enrolled(hub);
    expect(fs.statSync(path.join(dir, "client.key")).mode & 0o777).toBe(0o600);
    expect(enrollment.clientCert).toContain("BEGIN CERTIFICATE");
    expect(readConnection(dir).mode).toBe("hub");
    const dump = fs.readFileSync(path.join(hub.dataDir, "aio.db")).toString("latin1");
    expect(dump).not.toContain(enrollment.clientKey.split("\n")[1]);
    const list = (await hub.api("GET", "/api/v1/gui-clients")).json;
    expect(list.clients).toMatchObject([{ name: "desk-pc", status: "active" }]);
    expect(JSON.stringify(list)).not.toContain("BEGIN");
  });

  it("refuses a request with no certificate", async () => {
    const hub = await startServer("hub");
    const { code } = await enrolled(hub);
    expect((await call(code.hubUrl, "/api/v1/boxes", null)).status).toBe(401);
    expect((await call(code.hubUrl, "/boxes/", null)).status).toBe(401);
  });

  it("refuses a node's certificate, and a GUI certificate on the link", async () => {
    const hub = await startServer("hub");
    const node = await startServer("node");
    const nodeCode = (await hub.api("POST", "/api/v1/machines/enrollment-codes")).json;
    await node.api("POST", "/api/v1/node/join", {
      hubUrl: nodeCode.hubUrl,
      code: nodeCode.code,
      name: "node-one",
    });
    const { code, enrollment } = await enrolled(hub);
    const link = path.join(node.dataDir, "link");
    const nodeIdentity = {
      key: fs.readFileSync(path.join(link, "client.key"), "utf8"),
      cert: fs.readFileSync(path.join(link, "client.crt"), "utf8"),
    };
    expect((await call(code.hubUrl, "/api/v1/boxes", nodeIdentity)).status).toBe(403);

    // A certificate from the same authority with an unknown ID fares no better.
    const ca = {
      key: fs.readFileSync(path.join(hub.dataDir, "hub", "ca.key"), "utf8"),
      cert: fs.readFileSync(path.join(hub.dataDir, "hub", "ca.crt"), "utf8"),
    };
    const stray = newNodeKey();
    const strayCert = issueNodeCertificate(ca, "m0", stray.publicKey);
    expect(
      (await call(code.hubUrl, "/api/v1/boxes", { key: stray.key, cert: strayCert })).status,
    ).toBe(403);

    const ws = new WebSocket(`wss://127.0.0.1:${hub.app.multiHost.hub.port}/link/v1/connect`, {
      ...identityOf(enrollment),
      rejectUnauthorized: false,
    });
    sockets.push(ws);
    const status = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => undefined);
    });
    expect(status).toBe(401);
  });

  it("refuses a reused code, an expired code, a node's code, and a wrong one", async () => {
    const hub = await startServer("hub");
    const issue = async () => (await hub.api("POST", "/api/v1/gui-clients/enrollment-codes")).json;
    const dir = path.join(hub.home, "client");
    const code = await issue();
    await enrollWithHub(dir, { hubUrl: code.hubUrl, code: code.code, name: "one" });
    await expect(
      enrollWithHub(dir, { hubUrl: code.hubUrl, code: code.code, name: "two" }),
    ).rejects.toThrow(/wrong, used, or expired/);

    const expired = await issue();
    hub.app.core.db
      .prepare("UPDATE gui_enrollment_codes SET expires_at = ? WHERE used_at IS NULL")
      .run(new Date(Date.now() - 1000).toISOString());
    await expect(
      enrollWithHub(dir, { hubUrl: code.hubUrl, code: expired.code, name: "three" }),
    ).rejects.toThrow(/wrong, used, or expired/);

    const nodeCode = (await hub.api("POST", "/api/v1/machines/enrollment-codes")).json;
    await expect(
      enrollWithHub(dir, { hubUrl: code.hubUrl, code: nodeCode.code, name: "four" }),
    ).rejects.toThrow(/wrong, used, or expired/);
    await expect(
      enrollWithHub(dir, { hubUrl: code.hubUrl, code: "AAAA-BBBB-CCCC-DDDD", name: "five" }),
    ).rejects.toThrow(/wrong, used, or expired/);

    // A proof over another certificate, as a program in the middle would send, fails.
    const live = await issue();
    const key = guiCodeKey(live.code);
    const nonce = "ab".repeat(16);
    const { publicKey } = newNodeKey();
    const res = await call(code.hubUrl, GUI_ENROLL_PATH, null, {
      method: "POST",
      body: JSON.stringify({
        name: "six",
        publicKey,
        nonce,
        proof: guiClientProof(key, { hubFingerprint: "AA:BB", nonce, name: "six", publicKey }),
      }),
    });
    expect(res.status).toBe(401);
  });

  it("applies a revocation to the next request and closes open streams", async () => {
    const hub = await startServer("hub");
    const { code, enrollment } = await enrolled(hub);
    const identity = identityOf(enrollment);
    expect((await call(code.hubUrl, "/api/v1/boxes", identity)).status).toBe(200);
    // A second client keeps the listener on after the first is revoked.
    await enrolled(hub, "other-pc");

    const ws = new WebSocket(`${code.hubUrl.replace("https", "wss")}/api/v1/events`, {
      ...identity,
      rejectUnauthorized: false,
    });
    sockets.push(ws);
    await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));

    await hub.api("DELETE", `/api/v1/gui-clients/${enrollment.clientId}`);
    expect(await closed).toBe(4403);
    const res = await call(code.hubUrl, "/api/v1/boxes", identity);
    expect(res.status).toBe(403);
    expect(res.text).toContain("revoked");
    expect((await hub.api("GET", "/api/v1/gui-clients")).json.clients[0].status).toBe("revoked");
  });

  it("keeps enrollment management, credentials, and trust settings on the hub", async () => {
    const hub = await startServer("hub");
    const { code, enrollment } = await enrolled(hub);
    const identity = identityOf(enrollment);
    for (const [method, url] of [
      ["POST", "/api/v1/machines/enrollment-codes"],
      ["DELETE", "/api/v1/machines/m1"],
      ["GET", "/api/v1/gui-clients"],
      ["POST", "/api/v1/gui-clients/enrollment-codes"],
      ["DELETE", `/api/v1/gui-clients/${enrollment.clientId}`],
      ["POST", "/api/v1/node/join"],
      ["POST", "/api/v1/auth/session"],
      // The same routes, in the form that names this machine.
      ["POST", "/api/v1/machines/local/proxy/gui-clients/enrollment-codes"],
      ["POST", "/api/v1/machines/hub/proxy/auth/session"],
    ] as const) {
      const res = await call(code.hubUrl, url, identity, { method });
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    const grant = await call(code.hubUrl, "/api/v1/settings", identity, {
      method: "PATCH",
      body: JSON.stringify({ nodeGrants: { m1: { opRefs: ["op://Vault/Item/field"] } } }),
    });
    expect(grant.status).toBe(403);
    expect((await hub.api("GET", "/api/v1/settings")).json.nodeGrants).toBeUndefined();
    const plain = await call(code.hubUrl, "/api/v1/settings", identity);
    expect(plain.status).toBe(200);
  });
});

describe("GUI to hub to node to box", () => {
  it("controls a node's box through the proxy, and refuses what the proxy must", async () => {
    const hub = await startServer("hub");
    const node = await startServer("node");
    const nodeCode = (await hub.api("POST", "/api/v1/machines/enrollment-codes")).json;
    const joined = await node.api("POST", "/api/v1/node/join", {
      hubUrl: nodeCode.hubUrl,
      code: nodeCode.code,
      name: "node-one",
    });
    const machineId = joined.json.machineId as string;
    await waitFor(() => node.app.multiHost.status().link === "connected", 5000);
    const { enrollment } = await enrolled(hub);
    const proxy = await startHubProxy(enrollment);
    proxies.push(proxy);

    const fetchProxy = (url: string, init: RequestInit = {}, token: string | null = proxy.token) =>
      fetch(`${proxy.url}${url}`, {
        ...init,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
      });
    expect((await fetchProxy("/api/v1/boxes", {}, null)).status).toBe(401);
    expect((await fetchProxy("/api/v1/boxes", {}, "wrong")).status).toBe(401);
    // A raw request, because `fetch` would resolve the dot segments first.
    for (const raw of ["/boxes/../api/v1/boxes", "/boxes/%2e%2e/api/v1/boxes"]) {
      const status = await new Promise<number>((resolve, reject) => {
        http
          .get(`${proxy.url}/`, { path: raw }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on("error", reject);
      });
      expect(status, raw).toBe(401);
    }

    // The same token gets a cookie from the proxy, not a credential for the hub.
    const session = await fetchProxy("/api/v1/auth/session", { method: "POST" });
    expect(session.status).toBe(200);
    expect(session.headers.get("set-cookie")).toContain("aio_hub_session=");
    const cookie = (session.headers.get("set-cookie") as string).split(";")[0] as string;
    const viaCookie = await fetch(`${proxy.url}/api/v1/boxes`, { headers: { cookie } });
    expect(viaCookie.status).toBe(200);

    const machines = (await (await fetchProxy("/api/v1/machines")).json()) as Json;
    expect(machines.machines.map((m: Json) => m.name)).toContain("node-one");

    const via = (rest: string) => `/api/v1/machines/${machineId}/proxy/${rest}`;
    const dir = path.join(node.home, "work");
    fs.mkdirSync(dir);
    const created = await fetchProxy(via("boxes"), {
      method: "POST",
      body: JSON.stringify({ targetDir: dir, layout: "root" }),
    });
    expect(created.status).toBe(202);
    let list: Json = { boxes: [] };
    for (let i = 0; i < 100 && list.boxes.length === 0; i++) {
      list = await (await fetchProxy(via("boxes"))).json();
      if (list.boxes.length === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(list.boxes).toHaveLength(1);
    const boxId = list.boxes[0].box.id as string;
    const nodeBoxes = await node.api("GET", "/api/v1/boxes");
    expect(nodeBoxes.json.boxes[0].box.id).toBe(boxId);

    // The box starts running; stop it and start it again through every hop.
    const finished = async (res: Response) => {
      expect(res.status, await res.clone().text()).toBeLessThan(300);
      const job = (await res.json()) as Json;
      if (typeof job.id !== "string") return;
      let state: Json = job;
      for (let i = 0; i < 200 && state.status !== "finished" && state.status !== "failed"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        state = await (await fetchProxy(via(`jobs/${job.id}`))).json();
      }
      expect(state).toMatchObject({ status: "finished", exitCode: 0 });
    };
    await finished(await fetchProxy(via(`boxes/${boxId}/stop`), { method: "POST" }));
    await finished(await fetchProxy(via(`boxes/${boxId}/start`), { method: "POST" }));

    // A terminal through every hop reaches the node's exec backend.
    const query = `boxId=${boxId}&kind=shell&cols=80&rows=24`;
    const term = new WebSocket(`${proxy.url.replace("http", "ws")}${via(`terminals?${query}`)}`, {
      headers: { authorization: `Bearer ${proxy.token}` },
    });
    sockets.push(term);
    const frames: string[] = [];
    term.on("message", (data, isBinary) => {
      if (!isBinary) frames.push(data.toString());
    });
    await new Promise((resolve, reject) => term.once("open", resolve).once("error", reject));
    await waitFor(() => frames.some((f) => f.includes('"ready"')), 5000);
    expect(node.exec.sessions.length).toBeGreaterThan(0);
    expect(hub.exec.sessions).toHaveLength(0);

    // A socket from another origin, or one with no token, stays out.
    const refused = async (options: WebSocket.ClientOptions) => {
      const ws = new WebSocket(`${proxy.url.replace("http", "ws")}/api/v1/events`, options);
      sockets.push(ws);
      return new Promise<number>((resolve) => {
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("error", () => undefined);
      });
    };
    expect(await refused({})).toBe(401);
    expect(
      await refused({
        origin: "https://evil.example.com",
        headers: { authorization: `Bearer ${proxy.token}` },
      }),
    ).toBe(403);

    // Revoking the app ends the terminal and every later call.
    const closed = new Promise<void>((resolve) => term.once("close", () => resolve()));
    await hub.api("DELETE", `/api/v1/gui-clients/${enrollment.clientId}`);
    await closed;
    const after = await fetchProxy("/api/v1/boxes").catch(() => null);
    expect(after === null || after.status >= 400).toBe(true);
  });

  it("pins the hub: a replaced hub certificate gets no request", async () => {
    const hub = await startServer("hub");
    const other = await startServer("other");
    const { enrollment } = await enrolled(hub);
    const otherCode = (await other.api("POST", "/api/v1/gui-clients/enrollment-codes")).json;
    const proxy = await startHubProxy({ ...enrollment, hubUrl: otherCode.hubUrl });
    proxies.push(proxy);
    const res = await fetch(`${proxy.url}/api/v1/boxes`, {
      headers: { authorization: `Bearer ${proxy.token}` },
    });
    expect(res.status).toBe(502);
  });
});

describe("a GUI upgrade that doesn't reach the app", () => {
  /** A listener, one client's certificate, and a count of the API streams closed. */
  async function listener() {
    const hub = await startServer("hub");
    const { code, enrollment } = await enrolled(hub);
    const closes = vi.spyOn(WsStream.prototype, "close");
    return { hub, hubUrl: code.hubUrl as string, identity: identityOf(enrollment), closes };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes the API stream when the app's socket ends during the open", async () => {
    const { hub, hubUrl, identity, closes } = await listener();
    // `serveUpgrade` is waiting on the stream when this listener runs after it.
    const gui = hub.app.multiHost.gui as unknown as { server: https.Server };
    gui.server.on("upgrade", (_req, socket: Duplex) => socket.destroy());

    const ws = new WebSocket(`${hubUrl.replace("https", "wss")}/api/v1/events`, {
      ...identity,
      rejectUnauthorized: false,
    });
    sockets.push(ws);
    await new Promise((resolve) => ws.once("error", resolve));

    await waitFor(() => closes.mock.calls.length > 0);
  });

  it("closes the API stream when the handshake is refused", async () => {
    const { hubUrl, identity, closes } = await listener();
    const { hostname, port } = new URL(hubUrl);
    const socket = tls.connect({
      host: hostname,
      port: Number(port),
      ...identity,
      rejectUnauthorized: false,
    });
    hubSockets.push(socket);
    await new Promise((resolve) => socket.once("secureConnect", resolve));
    const answer = new Promise<string>((resolve) =>
      socket.once("data", (chunk: Buffer) => resolve(chunk.toString())),
    );
    socket.write(
      [
        "GET /api/v1/events HTTP/1.1",
        `Host: ${hostname}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==",
        "Sec-WebSocket-Version: 1",
        "",
        "",
      ].join("\r\n"),
    );

    expect(await answer).toContain("400");
    await waitFor(() => closes.mock.calls.length > 0);
  });
});

describe("a socket upgrade the hub hasn't answered", () => {
  /** A hub that accepts upgrades and never answers them, and a proxy to it. */
  async function silentHub() {
    const dir = fs.realpathSync(tempDir("aio-gui-silent-"));
    const identity = await loadOrCreateHubIdentity(dir);
    const pending: Duplex[] = [];
    const hub = https.createServer({ key: identity.link.key, cert: identity.link.cert });
    hub.on("upgrade", (_req, socket: Duplex) => {
      socket.on("error", () => undefined);
      pending.push(socket);
      hubSockets.push(socket);
    });
    await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
    hubs.push(hub);
    const { key, publicKey } = newNodeKey();
    const proxy = await startHubProxy({
      hubUrl: `https://127.0.0.1:${(hub.address() as net.AddressInfo).port}`,
      clientId: "client-1",
      name: "desk-pc",
      clientKey: key,
      clientCert: issueGuiCertificate(identity.ca, "client-1", publicKey),
      caCert: identity.ca.cert,
      hubCert: identity.link.cert,
    });
    proxies.push(proxy);
    return { pending, proxy };
  }

  /** Sends an upgrade request to the proxy and waits for the hub to receive it. */
  async function openPending(pending: Duplex[], proxy: HubProxy): Promise<net.Socket> {
    const { hostname, port } = new URL(proxy.url);
    const app = net.connect(Number(port), hostname);
    app.on("error", () => undefined);
    app.write(
      `GET /api/v1/events HTTP/1.1\r\nHost: ${hostname}:${port}\r\n` +
        `Authorization: Bearer ${proxy.token}\r\nConnection: Upgrade\r\n` +
        "Upgrade: websocket\r\n\r\n",
    );
    await waitFor(() => pending.length === 1);
    return app;
  }

  it("aborts the hub request when the app destroys its socket", async () => {
    const { pending, proxy } = await silentHub();
    const app = await openPending(pending, proxy);
    app.destroy();
    await waitFor(() => pending[0]?.destroyed === true);
  });

  it("aborts the hub request when the app ends its socket", async () => {
    const { pending, proxy } = await silentHub();
    const app = await openPending(pending, proxy);
    app.end();
    await waitFor(() => pending[0]?.destroyed === true);
    await waitFor(() => app.destroyed);
  });

  it("closes both sockets when the proxy closes", async () => {
    const { pending, proxy } = await silentHub();
    const app = await openPending(pending, proxy);
    const closed = new Promise<void>((resolve) => app.once("close", () => resolve()));
    app.resume();
    await proxy.close();
    await closed;
    await waitFor(() => pending[0]?.destroyed === true);
  });
});
