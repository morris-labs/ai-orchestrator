// The server certificate and the pinned client.
import { X509Certificate, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SERVER_CERT_NAME,
  ServerCertificateDateError,
  ServerIdentityError,
  asIdentityError,
  createServerIdentity,
  matchesPin,
  pinFromPem,
  pinnedFetch,
  readServerPin,
  type TlsIdentity,
} from "../src/tls.js";

const TOKEN = "SYNTHETIC_TOKEN_0123456789abcdef";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

/** An HTTPS server on loopback that records the requests it decrypts. */
async function httpsServer(identity: TlsIdentity) {
  const seen: { url: string; authorization?: string }[] = [];
  const server = https.createServer({ key: identity.key, cert: identity.cert }, (req, res) => {
    seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `https://127.0.0.1:${(server.address() as net.AddressInfo).port}`, seen };
}

describe("createServerIdentity", () => {
  it("makes a self-signed certificate for loopback that OpenSSL accepts", () => {
    const id = createServerIdentity({ now: new Date("2026-10-30T00:00:00Z") });
    const cert = new X509Certificate(id.cert);
    expect(cert.subject).toBe(`CN=${SERVER_CERT_NAME}`);
    expect(cert.issuer).toBe(cert.subject);
    expect(cert.verify(createPublicKey(id.key))).toBe(true);
    expect(cert.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(cert.checkHost("localhost")).toBe("localhost");
    expect(cert.checkIP("192.0.2.1")).toBeUndefined();
    expect(new Date(cert.validFrom).getTime()).toBeLessThan(Date.parse("2026-10-30T00:00:00Z"));
    expect(new Date(cert.validTo).getUTCFullYear()).toBe(2036);
  });

  it("encodes dates from 2050 on as GeneralizedTime", () => {
    const id = createServerIdentity({ now: new Date("2049-06-01T00:00:00Z"), days: 400 });
    expect(new Date(new X509Certificate(id.cert).validTo).getUTCFullYear()).toBe(2050);
  });

  it("gives every certificate its own key", () => {
    expect(pinFromPem(createServerIdentity().cert).fingerprint256).not.toBe(
      pinFromPem(createServerIdentity().cert).fingerprint256,
    );
  });
});

describe("readServerPin", () => {
  it("returns null without the file and refuses a file that isn't a certificate", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agentbox-tls-"));
    closers.push(async () => rmSync(dir, { recursive: true, force: true }));
    expect(readServerPin(path.join(dir, "server.crt"))).toBeNull();
    writeFileSync(path.join(dir, "server.crt"), "SYNTHETIC_NOT_A_CERT");
    expect(() => readServerPin(path.join(dir, "server.crt"))).toThrow(/doesn't hold a certificate/);
    const id = createServerIdentity();
    writeFileSync(path.join(dir, "server.crt"), id.cert);
    expect(readServerPin(path.join(dir, "server.crt"))?.fingerprint256).toBe(
      pinFromPem(id.cert).fingerprint256,
    );
  });

  it("matches a certificate in PEM or DER against the pin", () => {
    const id = createServerIdentity();
    const pin = pinFromPem(id.cert);
    expect(matchesPin(id.cert, pin)).toBe(true);
    expect(matchesPin(new X509Certificate(id.cert).raw, pin)).toBe(true);
    expect(matchesPin(createServerIdentity().cert, pin)).toBe(false);
    expect(matchesPin("SYNTHETIC_GARBAGE", pin)).toBe(false);
  });
});

describe("pinnedFetch", () => {
  it("talks to the server that presents the pinned certificate", async () => {
    const id = createServerIdentity();
    const server = await httpsServer(id);
    const fetchPinned = pinnedFetch(() => pinFromPem(id.cert));
    const res = await fetchPinned(`${server.url}/api/v1/health`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(server.seen).toEqual([{ url: "/api/v1/health", authorization: `Bearer ${TOKEN}` }]);
  });

  it("never sends the token to a TLS server with another certificate", async () => {
    const squatter = await httpsServer(createServerIdentity());
    const fetchPinned = pinnedFetch(() => pinFromPem(createServerIdentity().cert));
    await expect(
      fetchPinned(`${squatter.url}/api/v1/boxes`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    ).rejects.toBeInstanceOf(ServerIdentityError);
    expect(squatter.seen).toEqual([]);
  });

  it("never sends the token to a plain TCP listener", async () => {
    const received: Buffer[] = [];
    const squatter = net.createServer((socket) => {
      socket.on("data", (d: Buffer) => {
        received.push(d);
        socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}");
      });
    });
    await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => squatter.close(() => resolve())));
    const port = (squatter.address() as net.AddressInfo).port;
    const fetchPinned = pinnedFetch(() => pinFromPem(createServerIdentity().cert));
    await expect(
      fetchPinned(`https://127.0.0.1:${port}/`, { headers: { authorization: `Bearer ${TOKEN}` } }),
    ).rejects.toThrow();
    expect(Buffer.concat(received).toString("latin1")).not.toContain(TOKEN);
  });

  it("reads the pin again for every request", async () => {
    const first = createServerIdentity();
    const second = createServerIdentity();
    const server = await httpsServer(second);
    let pin = pinFromPem(first.cert);
    const fetchPinned = pinnedFetch(() => pin);
    await expect(fetchPinned(`${server.url}/`)).rejects.toThrow();
    pin = pinFromPem(second.cert);
    expect((await fetchPinned(`${server.url}/`)).status).toBe(200);
  });

  it("refuses plain http", async () => {
    const fetchPinned = pinnedFetch(() => pinFromPem(createServerIdentity().cert));
    await expect(fetchPinned("http://127.0.0.1:1/")).rejects.toThrow(/nothing over http:/);
  });

  it("blames the clock, not another program, for a certificate that isn't valid yet", async () => {
    const id = createServerIdentity({ now: new Date(Date.now() + 2 * 3600_000) });
    const server = await httpsServer(id);
    const fetchPinned = pinnedFetch(() => pinFromPem(id.cert));
    const err: unknown = await fetchPinned(`${server.url}/`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerCertificateDateError);
    expect((err as Error).message).toMatch(/isn't valid yet/);
    expect((err as Error).message).toContain(new X509Certificate(id.cert).validFrom);
    expect((err as Error).message).not.toMatch(/Another program/);
    expect(server.seen).toEqual([]);
  });

  it("reports an expired certificate as expired", () => {
    const err = asIdentityError(Object.assign(new Error("x"), { code: "CERT_HAS_EXPIRED" }), "h");
    expect(err).toBeInstanceOf(ServerCertificateDateError);
    expect((err as Error).message).toMatch(/has expired/);
    expect(
      asIdentityError(Object.assign(new Error("x"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "h"),
    ).toBeInstanceOf(ServerIdentityError);
  });

  it("names the data directory's certificate when the identity check fails", () => {
    expect(new ServerIdentityError("127.0.0.1").message).toMatch(/server\.crt/);
  });
});
