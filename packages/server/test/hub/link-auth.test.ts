// The hub's two gates, tested on a bare `Hub` with no API behind it:
// enrollment accepts a code once and only before it expires, and the link
// upgrade accepts only a client certificate that this hub's authority signed
// for an enrolled machine that isn't revoked.
import { X509Certificate, randomBytes } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { openDatabase } from "../../src/db/index.js";
import {
  issueNodeCertificate,
  loadOrCreateHubIdentity,
  newNodeKey,
  type HubIdentity,
} from "../../src/hub/ca.js";
import { Hub } from "../../src/hub/hub.js";
import { LINK_CAPABILITIES, LINK_PATHS, LINK_PROTOCOL } from "../../src/hub/protocol.js";
import { ENROLLMENT_CODE_TTL_MS, codeKey, nodeProof } from "../../src/hub/registry.js";
import { tempDir } from "../tmp.js";

const hubs: Hub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
});

interface TestHub {
  hub: Hub;
  identity: HubIdentity;
  /** Moves the hub's clock forward. */
  advance(ms: number): void;
}

async function startHub(): Promise<TestHub> {
  const dir = path.join(tempDir("aio-link-auth-"), "hub");
  // The hub loads the same authority from `dir`.
  const identity = await loadOrCreateHubIdentity(dir);
  let now = new Date("2026-11-01T10:00:00Z");
  const hub = new Hub({
    dir,
    db: openDatabase(":memory:"),
    isHub: () => true,
    hello: () => ({
      type: "hello",
      protocol: LINK_PROTOCOL,
      capabilities: [...LINK_CAPABILITIES],
      serverVersion: "1.0.0-test",
      platform: "linux",
      name: "hub-test",
      role: "both",
    }),
    port: () => 0,
    bindHost: "127.0.0.1",
    address: () => "127.0.0.1",
    token: "synthetic-token",
    api: () => null,
    internal: new Map(),
    allowNodeRequest: () => false,
    timing: { helloMs: 2000 },
    log: () => undefined,
    now: () => now,
  });
  hubs.push(hub);
  await hub.start();
  return {
    hub,
    identity,
    advance(ms) {
      now = new Date(now.getTime() + ms);
    },
  };
}

/** An enrollment request for `code`, with the proof over the hub's link certificate. */
function enrollRequest(identity: HubIdentity, code: string, name: string) {
  const { publicKey } = newNodeKey();
  const nonce = randomBytes(32).toString("hex");
  return {
    name,
    publicKey,
    nonce,
    proof: nodeProof(codeKey(code), {
      hubFingerprint: identity.linkFingerprint,
      nonce,
      name,
      publicKey,
    }),
  };
}

/** Opens the link route with an optional client certificate; resolves with the outcome. */
function connect(
  port: number,
  client?: { key: string; cert: string },
): Promise<{ status: number; body: string } | { open: true }> {
  return new Promise((resolve, reject) => {
    // The test checks the hub's side, so it doesn't verify the hub's certificate.
    const ws = new WebSocket(`wss://127.0.0.1:${port}${LINK_PATHS.connect}`, {
      rejectUnauthorized: false,
      ...(client ?? {}),
    });
    ws.once("open", () => {
      ws.terminate();
      resolve({ open: true });
    });
    ws.once("unexpected-response", (_req, res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    });
    ws.once("error", reject);
  });
}

describe("enrollment codes", () => {
  it("work once", async () => {
    const { hub, identity } = await startHub();
    const { code } = await hub.issueCode();
    const first = await hub.enroll(enrollRequest(identity, code, "node-one"));
    expect(first.machineId).toMatch(/^m[0-9a-f]{16}$/);
    await expect(hub.enroll(enrollRequest(identity, code, "node-two"))).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(hub.registry.liveCount()).toBe(1);
  });

  it("expire after 10 minutes", async () => {
    const { hub, identity, advance } = await startHub();
    const issued = await hub.issueCode();
    expect(new Date(issued.expiresAt).getTime() - Date.parse("2026-11-01T10:00:00Z")).toBe(
      ENROLLMENT_CODE_TTL_MS,
    );
    advance(ENROLLMENT_CODE_TTL_MS + 1000);
    await expect(
      hub.enroll(enrollRequest(identity, issued.code, "node-one")),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(hub.registry.count()).toBe(0);
  });

  it("stay unused when the hub refuses the name", async () => {
    const { hub, identity } = await startHub();
    await hub.enroll(enrollRequest(identity, (await hub.issueCode()).code, "node-one"));
    const { code } = await hub.issueCode();
    await expect(hub.enroll(enrollRequest(identity, code, "NODE-ONE"))).rejects.toMatchObject({
      code: "conflict",
    });
    const second = await hub.enroll(enrollRequest(identity, code, "node-two"));
    expect(second.name).toBe("node-two");
  });
});

describe("the link upgrade", () => {
  it("refuses a peer without a client certificate", async () => {
    const { hub } = await startHub();
    await hub.issueCode();
    const res = await connect(hub.port!);
    expect(res).toMatchObject({ status: 401, body: expect.stringMatching(/client certificate/) });
  });

  it("refuses a certificate that another authority signed", async () => {
    const { hub } = await startHub();
    await hub.issueCode();
    const other = await loadOrCreateHubIdentity(path.join(tempDir("aio-other-ca-"), "hub"));
    const key = newNodeKey();
    const cert = issueNodeCertificate(other.ca, "m0000000000000001", key.publicKey);
    // Even with the fingerprint in the registry, the chain decides.
    hub.registry.add({
      id: "m0000000000000001",
      name: "impostor",
      certFingerprint: new X509Certificate(cert).fingerprint256,
    });
    const res = await connect(hub.port!, { key: key.key, cert });
    expect(res).toMatchObject({ status: 401, body: expect.stringMatching(/client certificate/) });
  });

  it("refuses a self-signed certificate", async () => {
    const { hub } = await startHub();
    await hub.issueCode();
    const self = await loadOrCreateHubIdentity(path.join(tempDir("aio-self-"), "hub"));
    const res = await connect(hub.port!, { key: self.ca.key, cert: self.ca.cert });
    expect(res).toMatchObject({ status: 401 });
  });

  it("refuses a certificate this hub signed for no enrolled machine", async () => {
    const { hub, identity } = await startHub();
    await hub.issueCode();
    const key = newNodeKey();
    const cert = issueNodeCertificate(identity.ca, "m0000000000000002", key.publicKey);
    const res = await connect(hub.port!, { key: key.key, cert });
    expect(res).toMatchObject({ status: 401, body: expect.stringMatching(/doesn't know/) });
  });

  it("accepts an enrolled machine's certificate, and refuses it with 403 once revoked", async () => {
    const { hub, identity } = await startHub();
    await hub.issueCode();
    const key = newNodeKey();
    const cert = issueNodeCertificate(identity.ca, "m0000000000000003", key.publicKey);
    hub.registry.add({
      id: "m0000000000000003",
      name: "node-three",
      certFingerprint: new X509Certificate(cert).fingerprint256,
    });
    expect(await connect(hub.port!, { key: key.key, cert })).toEqual({ open: true });
    await hub.revoke("m0000000000000003");
    const res = await connect(hub.port!, { key: key.key, cert });
    expect(res).toMatchObject({ status: 403, body: expect.stringMatching(/revoked/) });
  });
});
