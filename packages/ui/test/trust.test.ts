// How the Electron main processes pin the server's certificate.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServerIdentity, pinFromPem } from "@aio/contracts/tls";
import { afterEach, describe, expect, it } from "vitest";
import { certificateVerdict, pinReader, pinnedWebSocket } from "../src/electron/trust";

const SERVER = "https://127.0.0.1:21400";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("certificateVerdict", () => {
  const id = createServerIdentity();
  const pin = () => pinFromPem(id.cert);

  it("accepts only the pinned certificate for the server's host", () => {
    expect(
      certificateVerdict({ hostname: "127.0.0.1", certificate: { data: id.cert } }, SERVER, pin),
    ).toBe(0);
    const other = createServerIdentity().cert;
    expect(
      certificateVerdict({ hostname: "127.0.0.1", certificate: { data: other } }, SERVER, pin),
    ).toBe(-2);
  });

  it("leaves other hosts to Chromium", () => {
    expect(
      certificateVerdict({ hostname: "example.com", certificate: { data: id.cert } }, SERVER, pin),
    ).toBe(-3);
    expect(
      certificateVerdict({ hostname: "localhost", certificate: { data: id.cert } }, SERVER, pin),
    ).toBe(-3);
  });

  it("refuses everything for the server's host when the certificate file is missing", () => {
    const missing = () => {
      throw new Error("No server certificate.");
    };
    expect(
      certificateVerdict(
        { hostname: "127.0.0.1", certificate: { data: id.cert } },
        SERVER,
        missing,
      ),
    ).toBe(-2);
  });

  it("compares IPv6 hosts without brackets", () => {
    expect(
      certificateVerdict(
        { hostname: "::1", certificate: { data: id.cert } },
        "https://[::1]:21400",
        pin,
      ),
    ).toBe(0);
  });
});

describe("pinReader", () => {
  it("reads the file again on every call and says when it's missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aio-trust-"));
    dirs.push(dir);
    const file = path.join(dir, "server.crt");
    const read = pinReader(file);
    expect(read).toThrow(/No server certificate at .*server\.crt/);
    const first = createServerIdentity().cert;
    writeFileSync(file, first);
    expect(read().fingerprint256).toBe(pinFromPem(first).fingerprint256);
    const second = createServerIdentity().cert;
    writeFileSync(file, second);
    expect(read().fingerprint256).toBe(pinFromPem(second).fingerprint256);
  });
});

describe("pinnedWebSocket", () => {
  it("adds the pinned TLS options to every socket and keeps the caller's headers", () => {
    const made: { url: string; options: Record<string, unknown> }[] = [];
    class Recording {
      constructor(url: string, options: Record<string, unknown>) {
        made.push({ url, options });
      }
    }
    const id = createServerIdentity();
    const Pinned = pinnedWebSocket(Recording, () => pinFromPem(id.cert));
    const socket = new Pinned("wss://127.0.0.1:21400/api/v1/events", {
      headers: { Authorization: "Bearer SYNTHETIC_TOKEN" },
    });
    expect(socket).toBeInstanceOf(Recording);
    expect(made[0]?.options).toMatchObject({
      headers: { Authorization: "Bearer SYNTHETIC_TOKEN" },
      ca: pinFromPem(id.cert).pem,
      rejectUnauthorized: true,
    });
    const check = made[0]?.options.checkServerIdentity as (h: string, c: object) => unknown;
    expect(
      check("127.0.0.1", { fingerprint256: pinFromPem(id.cert).fingerprint256 }),
    ).toBeUndefined();
    expect(check("127.0.0.1", { fingerprint256: "00" })).toBeInstanceOf(Error);
  });
});
