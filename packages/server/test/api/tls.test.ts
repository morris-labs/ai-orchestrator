// The server's key and certificate in the data directory.
import { X509Certificate, createPrivateKey } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServerIdentity } from "@aio/contracts/tls";
import { describe, expect, it } from "vitest";
import { loadOrCreateTlsIdentity, serverCertPath } from "../../src/api/tls.js";
import { tempDir } from "../tmp.js";

const mode = async (file: string) => (await stat(file)).mode & 0o777;

describe("loadOrCreateTlsIdentity", () => {
  it("creates the key 0600 and the certificate in a 0700 data directory, then reuses them", async () => {
    const home = tempDir("aio-tls-");
    const id = await loadOrCreateTlsIdentity(home);
    const dir = path.join(home, ".ai-orchestrator");
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(path.join(dir, "server.key"))).toBe(0o600);
    expect(await readFile(path.join(dir, "server.crt"), "utf8")).toBe(id.cert);
    expect(new X509Certificate(id.cert).checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(await loadOrCreateTlsIdentity(home)).toEqual(id);
    expect(serverCertPath(home)).toBe(path.join(dir, "server.crt"));
  });

  it("tightens an existing data directory and key that others can read", async () => {
    const home = tempDir("aio-tls-");
    const dir = path.join(home, ".ai-orchestrator");
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);
    const id = await loadOrCreateTlsIdentity(home);
    await chmod(path.join(dir, "server.key"), 0o644);
    await chmod(dir, 0o755);
    expect(await loadOrCreateTlsIdentity(home)).toEqual(id);
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(path.join(dir, "server.key"))).toBe(0o600);
  });

  it("uses the data directory in place of ~/.ai-orchestrator when given", async () => {
    const home = tempDir("aio-tls-");
    const dataDir = path.join(home, "data");
    const id = await loadOrCreateTlsIdentity(home, dataDir);
    expect(await readFile(path.join(dataDir, "server.crt"), "utf8")).toBe(id.cert);
    await expect(stat(path.join(home, ".ai-orchestrator"))).rejects.toThrow();
  });

  it("replaces a certificate that doesn't match the key", async () => {
    const home = tempDir("aio-tls-");
    const first = await loadOrCreateTlsIdentity(home);
    await writeFile(path.join(home, ".ai-orchestrator", "server.crt"), createServerIdentity().cert);
    const next = await loadOrCreateTlsIdentity(home);
    expect(next.cert).not.toBe(first.cert);
    expect(new X509Certificate(next.cert).checkPrivateKey(createPrivateKey(next.key))).toBe(true);
  });

  it("replaces a certificate within 30 days of its end", async () => {
    const home = tempDir("aio-tls-");
    const now = new Date("2026-10-30T00:00:00Z");
    const first = await loadOrCreateTlsIdentity(home, undefined, now);
    const later = new Date(Date.parse(new X509Certificate(first.cert).validTo) - 10 * 86400_000);
    const next = await loadOrCreateTlsIdentity(home, undefined, later);
    expect(next.cert).not.toBe(first.cert);
    expect(Date.parse(new X509Certificate(next.cert).validTo)).toBeGreaterThan(later.getTime());
  });

  it("replaces a key file that isn't a key", async () => {
    const home = tempDir("aio-tls-");
    const first = await loadOrCreateTlsIdentity(home);
    await writeFile(path.join(home, ".ai-orchestrator", "server.key"), "SYNTHETIC_NOT_A_KEY");
    expect((await loadOrCreateTlsIdentity(home)).cert).not.toBe(first.cert);
  });
});
