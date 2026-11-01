// Unit tests for the multi-host pieces: codes and proofs, the registry, the
// protocol helpers, the certificates, and the secret relay's clients.
import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import {
  issueNodeCertificate,
  loadOrCreateHubIdentity,
  newNodeKey,
} from "../../src/hub/ca.js";
import { defaultAllowNodeRequest, nameFromHost, parseRole } from "../../src/hub/multihost.js";
import { protocolMismatch, sendableCloseCode, closeReason } from "../../src/hub/protocol.js";
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
      role: "node",
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
  });

  it("parses roles, names machines after the host, and limits node calls", () => {
    expect(parseRole("hub")).toBe("hub");
    expect(parseRole("HUB")).toBeUndefined();
    expect(nameFromHost("desk.example.com")).toBe("desk");
    expect(nameFromHost("_weird_")).toBe("weird-");
    expect(defaultAllowNodeRequest({ method: "GET", path: "/api/v1/machines" })).toBe(true);
    expect(defaultAllowNodeRequest({ method: "POST", path: "/api/v1/machines" })).toBe(false);
    expect(defaultAllowNodeRequest({ method: "GET", path: "/api/v1/settings" })).toBe(false);
    expect(
      defaultAllowNodeRequest({ method: "POST", path: "/api/v1/machines/m1/proxy/api/v1/boxes" }),
    ).toBe(true);
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
