// Unit tests for the multi-host pieces: codes and proofs, the registry, the
// protocol helpers, the certificates, and the secret relay's clients.
import { X509Certificate, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import {
  issueNodeCertificate,
  loadOrCreateHubIdentity,
  newNodeKey,
  readNodeLinkFiles,
  writeAtomic,
} from "../../src/hub/ca.js";
import { HealthCache, measureHealth } from "../../src/hub/health.js";
import {
  HUB_BOX_ROUTES,
  defaultAllowNodeRequest,
  isHubBoxRoute,
  nameFromHost,
  parseRole,
} from "../../src/hub/multihost.js";
import {
  isCgnatIpv4,
  isPrivateIpv4,
  isTunnelInterface,
  lanCandidates,
  parseDefaultRoute,
  primaryLanAddress,
  readDefaultRouteInterface,
  withoutTunnels,
} from "../../src/hub/lan.js";
import {
  closeReason,
  parseFrame,
  protocolMismatch,
  sendableCloseCode,
} from "../../src/hub/protocol.js";
import {
  MachineRegistry,
  codeKey,
  hubProof,
  newEnrollmentCode,
  nodeProof,
  normalizeCode,
  sameHex,
} from "../../src/hub/registry.js";
import { HubOpClient, RoleOpClient } from "../../src/hub/secrets-relay.js";
import { CredentialStore, isCredentialKey } from "../../src/hub/credentials.js";
import { createDispatcher } from "../../src/hub/dispatch.js";
import type { OpClient } from "../../src/secrets/op.js";
import { tempDir } from "../tmp.js";

describe("enrollment codes and proofs", () => {
  it("makes 80-bit codes in four groups and normalizes what a person types", () => {
    const code = newEnrollmentCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(newEnrollmentCode()).not.toBe(code);
    expect(normalizeCode(" 7k2q-m9xd 4hpa-r3tb ")).toBe("7K2QM9XD4HPAR3TB");
    expect(normalizeCode("oIl0")).toBe("0110");
    expect(codeKey("7k2q m9xd 4hpa r3tb")).toBe(codeKey("7K2Q-M9XD-4HPA-R3TB"));
  });

  it("binds the node's proof to the hub certificate it saw", () => {
    const key = codeKey("7K2Q-M9XD-4HPA-R3TB");
    const parts = { hubFingerprint: "AA:BB", nonce: "ab".repeat(16), name: "n", publicKey: "k" };
    const proof = nodeProof(key, parts);
    expect(sameHex(proof, nodeProof(key, parts))).toBe(true);
    expect(sameHex(proof, nodeProof(key, { ...parts, hubFingerprint: "CC:DD" }))).toBe(false);
    expect(sameHex(proof, nodeProof(codeKey("other"), parts))).toBe(false);
    const hub = hubProof(key, { nonce: "1", machineId: "m", clientCert: "c", hubCert: "h" });
    expect(sameHex(hub, proof)).toBe(false);
    expect(sameHex("", "")).toBe(false);
  });
});

describe("the machine registry", () => {
  it("uses a code once, forgets expired ones, and counts live machines", () => {
    let now = new Date("2026-11-01T10:00:00Z");
    const registry = new MachineRegistry(openDatabase(":memory:"), () => now);
    registry.addCode("AAAA-BBBB-CCCC-DDDD", 60_000);
    const [key] = registry.liveCodeKeys();
    expect(key).toBe(codeKey("AAAA-BBBB-CCCC-DDDD"));
    expect(registry.useCode(key!)).toBe(true);
    expect(registry.useCode(key!)).toBe(false);
    registry.addCode("EEEE-FFFF-GGGG-HHHH", 60_000);
    now = new Date("2026-11-01T10:02:00Z");
    expect(registry.liveCodeKeys()).toEqual([]);

    registry.add({ id: "m1", name: "node-one", certFingerprint: "F1" });
    expect(registry.byLiveName("NODE-ONE")?.id).toBe("m1");
    expect(registry.liveCount()).toBe(1);
    registry.seen("m1", {
      serverVersion: "1.0.0",
      protocol: 1,
      capabilities: ["http.v1"],
      platform: "linux",
    });
    expect(registry.get("m1")).toMatchObject({ protocol: 1, capabilities: ["http.v1"] });
    expect(registry.revoke("m1")).toBe(true);
    expect(registry.revoke("nobody")).toBe(false);
    expect(registry.liveCount()).toBe(0);
    expect(registry.count()).toBe(1);
    // A revoked machine's name is free again.
    registry.add({ id: "m2", name: "node-one", certFingerprint: "F2" });
    expect(registry.byFingerprint("F2")?.id).toBe("m2");
  });
});

describe("protocol helpers", () => {
  it("compares protocol major versions and names the machine to update", () => {
    expect(protocolMismatch(1, 1)).toBeNull();
    expect(protocolMismatch(1, 2)).toMatch(/Update AI Orchestrator on this machine/);
    expect(protocolMismatch(2, 1)).toMatch(/on the other machine/);
  });

  it("keeps close codes and reasons sendable", () => {
    expect(sendableCloseCode(undefined)).toBe(1000);
    expect(sendableCloseCode(1005)).toBe(1000);
    expect(sendableCloseCode(1006)).toBe(1011);
    expect(sendableCloseCode(4403)).toBe(4403);
    expect(sendableCloseCode(42)).toBe(1011);
    expect(Buffer.byteLength(closeReason("x".repeat(500)))).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(closeReason("\u00e9".repeat(500)))).toBeLessThanOrEqual(120);
    // A reason from the other end can be megabytes long; the trim stays quick.
    const started = Date.now();
    expect(closeReason("x".repeat(2 * 1024 * 1024))).toHaveLength(120);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("bounds the reason of an end frame from the other end", () => {
    const text = JSON.stringify({ type: "end", id: "n1", code: 1000, reason: "x".repeat(4096) });
    expect(parseFrame(text)).toEqual({
      type: "end",
      id: "n1",
      code: 1000,
      reason: "x".repeat(120),
    });
  });

  it("parses roles, names machines after the host, and limits node calls", () => {
    expect(parseRole("hub")).toBe("hub");
    expect(parseRole("HUB")).toBeUndefined();
    expect(nameFromHost("desk.example.com")).toBe("desk");
    expect(nameFromHost("_weird_")).toBe("weird-");
    expect(defaultAllowNodeRequest({ method: "GET", path: "/api/v1/machines" })).toBe(true);
    expect(defaultAllowNodeRequest({ method: "POST", path: "/api/v1/machines" })).toBe(false);
    expect(defaultAllowNodeRequest({ method: "GET", path: "/api/v1/settings" })).toBe(false);
    // A per-machine route that names the hub is held to the same list.
    for (const id of ["local", "hub", "%6Cocal"]) {
      expect(
        defaultAllowNodeRequest({ method: "GET", path: `/api/v1/machines/${id}/proxy/settings` }),
      ).toBe(false);
      expect(
        defaultAllowNodeRequest({ method: "GET", path: `/api/v1/machines/${id}/proxy/health` }),
      ).toBe(true);
      expect(
        defaultAllowNodeRequest({
          method: "GET",
          path: `/api/v1/machines/${id}/proxy/machines/${id}/proxy/settings`,
        }),
      ).toBe(false);
    }
    expect(
      defaultAllowNodeRequest(
        { method: "GET", path: "/api/v1/machines/hub-id/proxy/settings" },
        (id) => id === "hub-id",
      ),
    ).toBe(false);
  });
});

const CONTROL_ROUTES: [string, string][] = [
  ["POST", "boxes/b-1/start"],
  ["POST", "boxes/b-1/stop"],
  ["POST", "boxes/b-1/restart"],
  ["GET", "terminals"],
  ["GET", "fs/dirs"],
  ["GET", "events"],
];

describe("what a node may call on a hub that runs boxes", () => {
  const isHub = (id: string) => id === "local" || id === "hub";
  const allowed: [string, string][] = [
    ["GET", "/api/v1/boxes"],
    ["GET", "/api/v1/boxes/b-1"],
    ["GET", "/api/v1/projects"],
  ];
  const refused: [string, string][] = [
    ["GET", "/api/v1/settings"],
    ["PATCH", "/api/v1/settings"],
    ["GET", "/api/v1/secrets/available"],
    ["GET", "/api/v1/accounts"],
    ["POST", "/api/v1/machines/enrollment-codes"],
    ["DELETE", "/api/v1/machines/m1"],
    ["GET", "/api/v1/node"],
    ["POST", "/api/v1/node/join"],
    ["POST", "/api/v1/boxes"],
    ["PATCH", "/api/v1/boxes/b-1"],
    ["DELETE", "/api/v1/boxes/b-1"],
    ["POST", "/api/v1/boxes/b-1/purge"],
    ["POST", "/api/v1/projects"],
    ["GET", "/api/v1/boxes/b-1/start"],
    ["POST", "/api/v1/boxes/../settings"],
    ["GET", "/api/v1/boxes/.."],
    ["GET", "/api/v1/boxes/%2e%2e"],
    ["POST", "/api/v1/boxes/b-1/start/extra"],
    ["GET", "/api/v1/boxes/b-1/sub"],
  ];

  it("allows the read-only box routes only when the role is both", () => {
    for (const [method, path] of allowed) {
      expect(defaultAllowNodeRequest({ method, path }, isHub, true), path).toBe(true);
      expect(defaultAllowNodeRequest({ method, path }, isHub, false), path).toBe(false);
      expect(isHubBoxRoute({ method: method.toLowerCase(), path }), path).toBe(true);
    }
  });

  it("refuses box control, terminals, directories, and events on the hub", () => {
    for (const [method, rest] of CONTROL_ROUTES) {
      for (const url of [`/api/v1/${rest}`, `/api/v1/machines/hub/proxy/${rest}`]) {
        expect(defaultAllowNodeRequest({ method, path: url }, isHub, true), url).toBe(false);
      }
    }
  });

  it("keeps settings, secrets, accounts, machines, node, and edit routes refused", () => {
    for (const [method, path] of refused) {
      expect(defaultAllowNodeRequest({ method, path }, isHub, true), path).toBe(false);
    }
  });

  it("holds the per-machine route that names the hub to the same list", () => {
    for (const id of ["local", "hub"]) {
      const via = (rest: string) => `/api/v1/machines/${id}/proxy/${rest}`;
      expect(defaultAllowNodeRequest({ method: "GET", path: via("boxes") }, isHub, true)).toBe(
        true,
      );
      expect(defaultAllowNodeRequest({ method: "GET", path: via("boxes") }, isHub, false)).toBe(
        false,
      );
      expect(defaultAllowNodeRequest({ method: "GET", path: via("settings") }, isHub, true)).toBe(
        false,
      );
    }
    expect(HUB_BOX_ROUTES).not.toContain("terminals.open");
  });
});

describe("what a node may call on another node", () => {
  const via = (rest: string) => `/api/v1/machines/m2/proxy/${rest}`;
  const allowed: [string, string][] = [
    ["GET", "health"],
    ["GET", "boxes"],
    ["GET", "projects"],
    ["GET", "runs"],
    ["GET", "runs/r-1/findings"],
  ];
  const refused: [string, string][] = [
    ["GET", "settings"],
    ["PATCH", "settings"],
    ["GET", "secrets"],
    ["GET", "secrets/available"],
    ["GET", "accounts"],
    ["GET", "node"],
    ["POST", "node/join"],
    ["POST", "machines/enrollment-codes"],
    ["POST", "boxes"],
    ["DELETE", "boxes/b-1"],
    ["PATCH", "boxes/b-1"],
    ["POST", "runs"],
    ["GET", "machines/m3/proxy/settings"],
    ["GET", "machines/local/proxy/boxes"],
    ["GET", "boxes/../settings"],
  ];

  const allow = (method: string, rest: string) =>
    defaultAllowNodeRequest({ method, path: via(rest) });

  it("allows the read-only box and review routes", () => {
    for (const [method, rest] of allowed) {
      expect(allow(method, rest), rest).toBe(true);
    }
  });

  it("refuses box control, terminals, directories, and events", () => {
    for (const [method, rest] of CONTROL_ROUTES) {
      expect(allow(method, rest), rest).toBe(false);
    }
  });

  it("refuses every other route", () => {
    for (const [method, rest] of refused) {
      expect(allow(method, rest), rest).toBe(false);
    }
  });

  it("refuses a path that a URL parser would rewrite into another route", () => {
    for (const path of [
      "/api/v1/machines/m2/proxy/../../../settings",
      "/api/v1/machines/m2/proxy/%2e%2e/%2e%2e/%2e%2e/settings",
      "/api/v1/machines/m2/proxy/..\\..\\..\\settings",
      "/api/v1/boxes/a\\..\\..\\settings",
      "/api/v1/machines/x\\..\\local/proxy/boxes",
      "/api/v1/machines/lo\tcal/proxy/boxes",
      "//link.example.com/api/v1/health",
    ]) {
      expect(defaultAllowNodeRequest({ method: "GET", path }), path).toBe(false);
      expect(defaultAllowNodeRequest({ method: "GET", path }, undefined, true), path).toBe(false);
    }
  });
});

describe("hub certificates", () => {
  it("creates a private authority and signs link and node certificates with it", async () => {
    const dir = path.join(tempDir("aio-ca-"), "hub");
    const identity = await loadOrCreateHubIdentity(dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "ca.key")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, "link.key")).mode & 0o777).toBe(0o600);
    const ca = new X509Certificate(identity.ca.cert);
    const link = new X509Certificate(identity.link.cert);
    expect(ca.ca).toBe(true);
    expect(link.ca).toBe(false);
    expect(link.verify(ca.publicKey)).toBe(true);
    expect(link.checkIssued(ca)).toBe(true);
    expect(link.keyUsage).toContain("1.3.6.1.5.5.7.3.1");

    const node = newNodeKey();
    const cert = new X509Certificate(issueNodeCertificate(identity.ca, "m1", node.publicKey));
    expect(cert.subject).toBe("CN=aio-node:m1");
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(cert.keyUsage).toContain("1.3.6.1.5.5.7.3.2");
    expect(() => issueNodeCertificate(identity.ca, "m1", "nonsense")).toThrow(/PEM public key/);

    // A second start keeps the same identity.
    const again = await loadOrCreateHubIdentity(dir);
    expect(again.linkFingerprint).toBe(identity.linkFingerprint);
    expect(again.ca.cert).toBe(identity.ca.cert);
  });
});

describe("the atomic writer", () => {
  it("ignores a directory planted at the process's temporary name", async () => {
    const dir = tempDir("aio-atomic-");
    const file = path.join(dir, "auth.json");
    fs.mkdirSync(`${file}.${process.pid}.tmp`);
    await writeAtomic(file, "content", 0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("content");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("replaces a link at the file without following it and leaves no temporary file", async () => {
    const dir = tempDir("aio-atomic-");
    const file = path.join(dir, "auth.json");
    const outside = path.join(dir, "outside");
    fs.writeFileSync(outside, "keep");
    fs.chmodSync(outside, 0o644);
    fs.symlinkSync(outside, file);
    await writeAtomic(file, Buffer.from("content"), 0o600);
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(outside, "utf8")).toBe("keep");
    expect(fs.statSync(outside).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(dir).sort()).toEqual(["auth.json", "outside"]);
  });

  it("replaces a directory in the way of the file", async () => {
    const dir = tempDir("aio-atomic-");
    const file = path.join(dir, "auth.json");
    fs.mkdirSync(path.join(file, "nested"), { recursive: true });
    await writeAtomic(file, "content", 0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("content");
    expect(fs.readdirSync(dir)).toEqual(["auth.json"]);
  });
});

describe("the node's link files", () => {
  it.each(["{ not json", "[]"])(
    "treats a damaged node.json file, %s, as not joined",
    async (text) => {
      const dir = tempDir("aio-link-");
      for (const name of ["client.key", "client.crt", "hub-ca.crt", "hub.crt"]) {
        fs.writeFileSync(path.join(dir, name), "pem");
      }
      fs.writeFileSync(path.join(dir, "node.json"), text);
      const warnings: string[] = [];
      await expect(readNodeLinkFiles(dir, (m) => warnings.push(m))).resolves.toBeNull();
      expect(warnings).toEqual([expect.stringContaining(path.join(dir, "node.json"))]);
    },
  );
});

describe("the link dispatcher", () => {
  it("keeps a session cookie out of the response it sends over the link", async () => {
    const api = Fastify();
    api.get("/cookie", async (_request, reply) => {
      reply.header("set-cookie", "aio_session=synthetic").header("x-kept", "yes");
      return { ok: true };
    });
    const dispatcher = createDispatcher({
      api: () => api,
      token: "synthetic-token",
      caller: "m1",
      internal: new Map(),
    });
    const res = await dispatcher.request({ method: "GET", path: "/cookie", headers: {} });
    await api.close();
    expect(res.status).toBe(200);
    expect(res.headers["x-kept"]).toBe("yes");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});

/** A sync entry for `text`, with its hash. */
function entryOf(key: string, text: string) {
  const bytes = Buffer.from(text);
  return {
    key,
    content: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

describe("sign-in sync keys", () => {
  it("allows only the known sign-in files, with no way out of their folders", async () => {
    expect(isCredentialKey("host/claude/.credentials.json")).toBe(true);
    expect(isCredentialKey("account/codex/work/auth.json")).toBe(true);
    expect(isCredentialKey("account/codex/work/.credentials.json")).toBe(false);
    expect(isCredentialKey("account/claude/../x/.credentials.json")).toBe(false);
    expect(isCredentialKey("account/copilot/me/config.json")).toBe(false);
    expect(isCredentialKey("host/claude/settings.json")).toBe(false);
    const home = tempDir("aio-cred-");
    const store = new CredentialStore({ home, dataDir: path.join(home, "data") });
    expect(store.pathFor("account/claude/work/.credentials.json")).toBe(
      path.join(home, "data", "accounts", "claude", "work", ".credentials.json"),
    );
    // No folder, no file.
    expect(await store.write(entryOf("host/codex/auth.json", '{"t":"a"}'))).toBe(false);
    await expect(store.write(entryOf("host/../../etc/passwd", '{"t":"a"}'))).rejects.toThrow();
  });
});

describe("the sign-in store", () => {
  const key = "host/claude/.credentials.json";
  const setup = () => {
    const home = tempDir("aio-cred-");
    fs.mkdirSync(path.join(home, ".claude"));
    const file = path.join(home, ".claude", ".credentials.json");
    const open = () => new CredentialStore({ home, dataDir: path.join(home, "data") });
    return { home, file, open };
  };

  it("refuses an entry that is empty, malformed, or doesn't match its hash", async () => {
    const { file, open } = setup();
    fs.writeFileSync(file, '{"t":"good"}');
    const store = open();
    const valid = entryOf(key, '{"t":"next"}');
    for (const bad of [
      { key, content: "", sha256: createHash("sha256").update("").digest("hex") },
      { ...valid, content: "!!!!" },
      { ...valid, sha256: "0".repeat(64) },
      entryOf(key, "not json"),
      entryOf(key, "[]"),
      entryOf(key, "{}"),
    ]) {
      await expect(store.write(bad), bad.content).rejects.toThrow(/valid sign-in/);
    }
    expect(fs.readFileSync(file, "utf8")).toBe('{"t":"good"}');
  });

  it("keeps a node's linked sign-in file when told to keep local changes", async () => {
    const { file, open } = setup();
    const target = `${file}.target`;
    fs.writeFileSync(target, '{"t":"mine"}');
    fs.symlinkSync(target, file);
    const store = open();
    expect(await store.write(entryOf(key, '{"t":"hub"}'), { keepLocalChange: true })).toBe(false);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe('{"t":"mine"}');
  });

  it("doesn't count a listed file as synced", async () => {
    const { file, open } = setup();
    fs.writeFileSync(file, '{"t":"1"}');
    const store = open();
    await store.prime();
    fs.writeFileSync(file, '{"t":"2"}');
    await store.list();
    expect((await store.changes()).map((e) => e.key)).toEqual([key]);
  });

  it("keeps reporting a change until it syncs, and copying keeps it in place", async () => {
    const { file, open } = setup();
    fs.writeFileSync(file, '{"t":"1"}');
    const store = open();
    await store.prime();
    fs.writeFileSync(file, '{"t":"2"}');
    const [change] = await store.changes();
    expect(await store.changes()).toHaveLength(1);

    const older = entryOf(key, '{"t":"1"}');
    expect(await store.write(older, { keepLocalChange: true })).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe('{"t":"2"}');

    await store.markSynced(key, change!.sha256);
    expect(await store.changes()).toEqual([]);
    expect(await store.write(older, { keepLocalChange: true })).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe('{"t":"1"}');
    expect(await store.changes()).toEqual([]);
  });

  it("finds a change made while the server was stopped", async () => {
    const { file, open } = setup();
    fs.writeFileSync(file, '{"t":"1"}');
    await open().prime();
    fs.writeFileSync(file, '{"t":"2"}');
    const restarted = open();
    await restarted.prime();
    expect((await restarted.changes()).map((e) => e.key)).toEqual([key]);
  });

  it("treats every file as a node's own after a join, so a copy doesn't replace it", async () => {
    const { file, open } = setup();
    fs.writeFileSync(file, '{"t":"own"}');
    const store = open();
    await store.prime();
    await store.forget();
    expect(await store.write(entryOf(key, '{"t":"hub"}'), { keepLocalChange: true })).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe('{"t":"own"}');

    // A missing file takes the copy, and then counts as the hub's.
    fs.rmSync(file);
    expect(await store.write(entryOf(key, '{"t":"hub"}'), { keepLocalChange: true })).toBe(true);
    expect(await store.write(entryOf(key, '{"t":"hub2"}'), { keepLocalChange: true })).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe('{"t":"hub2"}');
  });

  it("sends nothing for what a machine already has on its first start", async () => {
    const { file, open } = setup();
    fs.writeFileSync(file, '{"t":"1"}');
    const store = open();
    await store.prime();
    expect(await store.changes()).toEqual([]);
  });

  it("leaves a failed write looking unchanged, so the old file isn't sent back", async () => {
    const { home, file, open } = setup();
    fs.writeFileSync(file, '{"t":"1"}');
    const store = open();
    await store.prime();
    fs.chmodSync(path.join(home, ".claude"), 0o555);
    try {
      await expect(store.write(entryOf(key, '{"t":"2"}'))).rejects.toThrow();
    } finally {
      fs.chmodSync(path.join(home, ".claude"), 0o755);
    }
    expect(fs.readFileSync(file, "utf8")).toBe('{"t":"1"}');
    expect(await store.changes()).toEqual([]);
  });
});

describe("the secret relay's clients", () => {
  const local: OpClient = {
    status: async () => ({ installed: true, version: "2", signedIn: true, mode: "desktop" }),
    read: async () => "local",
    listItems: async () => [],
  };

  it("asks the hub only while the role is node", async () => {
    let node = false;
    const relay = new HubOpClient(() => undefined);
    const op = new RoleOpClient(local, relay, () => node);
    expect(await op.read("op://V/i/f")).toBe("local");
    node = true;
    expect(await op.status()).toMatchObject({ installed: false, signedIn: false });
    await expect(op.read("op://V/i/f")).rejects.toMatchObject({ code: "secrets_unavailable" });
  });

  it("turns the hub's error into the same error code", async () => {
    const relay = new HubOpClient(() => ({
      machineId: "hub",
      request: async () => ({
        status: 503,
        headers: {},
        body: Buffer.from(
          JSON.stringify({ error: { code: "secrets_locked", message: "Not signed in." } }),
        ),
      }),
      openStream: async () => {
        throw new Error("unused");
      },
      onClose: () => undefined,
    }));
    await expect(relay.read("op://V/i/f")).rejects.toMatchObject({
      code: "secrets_locked",
      message: "The hub: Not signed in.",
    });
  });
});

describe("machine health", () => {
  const health = (at: string) => ({
    engineVersion: "1.0.0",
    expectedEngineVersion: "1.0.0",
    image: "ready" as const,
    diskFreeBytes: 1,
    diskTotalBytes: 2,
    checkedAt: at,
  });

  it("measures the image and the data directory's disk, and reads a failure as unknown", async () => {
    const dir = tempDir("aio-health-");
    const measured = await measureHealth({
      dataDir: dir,
      expectedEngineVersion: "1.0.0",
      imageStatus: async () => ({
        name: "aio-agent:latest",
        exists: true,
        imageId: "sha256:0",
        createdAt: null,
        engineVersion: "0.9.0",
        expectedEngineVersion: "1.0.0",
        engineMatches: false,
        cliVersions: { claude: null, codex: null, copilot: null },
      }),
    });
    expect(measured).toMatchObject({ engineVersion: "0.9.0", image: "mismatch" });
    expect(measured.diskTotalBytes).toBeGreaterThanOrEqual(measured.diskFreeBytes ?? 0);
    const failed = await measureHealth({
      dataDir: path.join(dir, "missing"),
      expectedEngineVersion: "1.0.0",
      imageStatus: async () => {
        throw new Error("Docker is unreachable.");
      },
    });
    expect(failed).toMatchObject({ image: "unknown", diskFreeBytes: null, diskTotalBytes: null });
  });

  it("caches each machine's health, refreshes it when stale, and keeps it when a refresh fails", async () => {
    let now = 0;
    const cache = new HealthCache(1000, () => now);
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return health(`t${calls}`);
    };
    expect((await cache.get("m1", fetch))?.checkedAt).toBe("t1");
    expect((await cache.get("m1", fetch))?.checkedAt).toBe("t1");
    expect(calls).toBe(1);
    now = 2000;
    await expect(
      cache.get("m1", async () => {
        throw new Error("The link dropped.");
      }),
    ).resolves.toMatchObject({ checkedAt: "t1" });
    now = 4000;
    // A slow node doesn't hold the list up past the wait.
    const slow = cache.get("m1", () => new Promise(() => undefined), 10);
    await expect(slow).resolves.toMatchObject({ checkedAt: "t1" });
    expect(cache.peek("m2")).toBeNull();
    cache.delete("m1");
    expect(cache.peek("m1")).toBeNull();
  });
});

describe("the link listener's LAN address", () => {
  const v4 = (address: string, internal = false) => ({ address, family: "IPv4", internal });
  const table = {
    lo: [v4("127.0.0.1", true), { address: "::1", family: "IPv6", internal: true }],
    docker0: [v4("172.17.0.1")],
    "br-0a1b2c3d4e5f": [v4("172.18.0.1")],
    veth12ab34: [v4("169.254.10.1")],
    tailscale0: [
      v4("100.101.102.103"),
      { address: "fd7a:115c::1", family: "IPv6", internal: false },
    ],
    wlp3s0: [v4("10.0.0.23")],
    enp5s0: [{ address: "fe80::1", family: "IPv6", internal: false }, v4("192.168.1.20")],
  };

  it("picks the private address of the interface on the default route", () => {
    expect(primaryLanAddress(table, "enp5s0")).toBe("192.168.1.20");
    expect(primaryLanAddress(table, "wlp3s0")).toBe("10.0.0.23");
  });

  it("ignores loopback, Docker bridges, Tailscale, and public addresses", () => {
    expect(lanCandidates(table)).toEqual([
      { name: "wlp3s0", address: "10.0.0.23" },
      { name: "enp5s0", address: "192.168.1.20" },
    ]);
    expect(primaryLanAddress({ eth0: [v4("198.51.100.7")], ...table }, "eth0")).toBeUndefined();
    expect(
      primaryLanAddress({ tailscale0: table.tailscale0, docker0: table.docker0 }, "tailscale0"),
    ).toBeUndefined();
    expect(primaryLanAddress({ wg0: [v4("100.64.0.9")] }, "wg0")).toBeUndefined();
  });

  it("doesn't bind a VPN with a private address on the default route", () => {
    const eth0 = [v4("192.168.1.20")];
    for (const vpn of ["tun0", "tap0", "wg0", "ppp0"]) {
      const hosts = { eth0, [vpn]: [v4("10.8.0.2")] };
      expect(lanCandidates(hosts)).toEqual([{ name: "eth0", address: "192.168.1.20" }]);
      expect(primaryLanAddress(hosts, vpn)).toBe("192.168.1.20");
    }
  });

  it("finds a VPN from the kernel's link type when its name doesn't show it", () => {
    const sys = tempDir("aio-sysfs-");
    const add = (name: string, type: string, tunFlags = false) => {
      fs.mkdirSync(path.join(sys, name));
      fs.writeFileSync(path.join(sys, name, "type"), `${type}\n`);
      if (tunFlags) fs.writeFileSync(path.join(sys, name, "tun_flags"), "0x1002\n");
    };
    add("eth0", "1");
    add("office", "65534"); // WireGuard or TUN, under a custom name.
    add("vpntap", "1", true); // TAP has an Ethernet link type.
    const hosts = {
      eth0: [v4("192.168.1.20")],
      office: [v4("10.8.0.2")],
      vpntap: [v4("10.9.0.2")],
      unknown: [v4("10.10.0.2")],
    };
    expect(isTunnelInterface("office", sys)).toBe(true);
    expect(isTunnelInterface("vpntap", sys)).toBe(true);
    expect(isTunnelInterface("eth0", sys)).toBe(false);
    expect(isTunnelInterface("unknown", sys)).toBe(false);
    expect(Object.keys(withoutTunnels(hosts, sys))).toEqual(["eth0", "unknown"]);
    const { unknown: _, ...known } = hosts;
    expect(primaryLanAddress(withoutTunnels(known, sys), "office")).toBe("192.168.1.20");
  });

  it("takes the only LAN address when the default route has none", () => {
    const one = {
      lo: table.lo,
      docker0: table.docker0,
      tailscale0: table.tailscale0,
      eth0: [v4("172.20.4.5")],
    };
    expect(primaryLanAddress(one, "tailscale0")).toBe("172.20.4.5");
    expect(primaryLanAddress(one, undefined)).toBe("172.20.4.5");
    expect(primaryLanAddress(table, "tailscale0")).toBeUndefined();
    expect(primaryLanAddress(table, undefined)).toBeUndefined();
    expect(primaryLanAddress({}, undefined)).toBeUndefined();
  });

  it("knows the private and carrier-grade NAT ranges", () => {
    for (const a of ["10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.0.1"]) {
      expect(isPrivateIpv4(a)).toBe(true);
    }
    for (const a of [
      "172.15.0.1",
      "172.32.0.1",
      "192.169.0.1",
      "100.64.0.1",
      "8.8.8.8",
      "10.0.0",
      "x",
    ]) {
      expect(isPrivateIpv4(a)).toBe(false);
    }
    expect(isCgnatIpv4("100.64.0.1")).toBe(true);
    expect(isCgnatIpv4("100.127.255.255")).toBe(true);
    expect(isCgnatIpv4("100.128.0.1")).toBe(false);
  });

  it("reads the default route from /proc/net/route", () => {
    const route = [
      "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
      "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
      "enp5s0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0",
      "enp5s0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0",
    ].join("\n");
    expect(parseDefaultRoute(route)).toBe("enp5s0");
    expect(parseDefaultRoute(route.split("\n").slice(0, 2).join("\n"))).toBeUndefined();
    expect(readDefaultRouteInterface("/nonexistent/route")).toBeUndefined();
  });
});
