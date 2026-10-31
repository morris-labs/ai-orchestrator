// The server's TLS identity and the client side of pinning it.
//
// The server serves its API over HTTPS with a self-signed certificate that
// it creates in its data directory on first start. Every client reads that
// certificate from the same directory and refuses a server that presents any
// other, so a process that binds the server port while the server is down
// never receives the token.
//
// This module uses Node.js built-ins. Import it as `@agentbox/contracts/tls`
// from Node.js and Electron main processes only, never from page code.
//
// The certificate is built with `node:crypto` and a small DER encoder rather
// than a dependency or the `openssl` command: the fields are fixed, the
// encoder is short enough to read in one sitting, and the tests check the
// result with OpenSSL through a real TLS handshake.
import {
  X509Certificate,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import https from "node:https";
import type { PeerCertificate } from "node:tls";

// ---------------------------------------------------------------------------
// DER encoding, only what a self-signed certificate needs.

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...body: Buffer[]): Buffer {
  const content = Buffer.concat(body);
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

const sequence = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);
const explicit = (n: number, item: Buffer) => tlv(0xa0 + n, item);
const octetString = (value: Buffer) => tlv(0x04, value);
const bitString = (value: Buffer) => tlv(0x03, Buffer.from([0]), value);
const utf8String = (value: string) => tlv(0x0c, Buffer.from(value, "utf8"));

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [40 * (parts[0] as number) + (parts[1] as number)];
  for (const part of parts.slice(2)) {
    const groups = [part & 0x7f];
    for (let v = part >>> 7; v > 0; v >>>= 7) groups.unshift((v & 0x7f) | 0x80);
    out.push(...groups);
  }
  return tlv(0x06, Buffer.from(out));
}

/** A non-negative INTEGER from big-endian bytes. */
function integer(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  const body = (trimmed[0] as number) & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;
  return tlv(0x02, body);
}

/** UTCTime before 2050 and GeneralizedTime from then on, as RFC 5280 requires. */
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, "ascii"))
    : tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
}

const OID = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  subjectAltName: "2.5.29.17",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
} as const;

/** A PEM block of `label` around DER bytes. */
function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// ---------------------------------------------------------------------------
// The certificate.

/** The common name of the server's certificate. */
export const SERVER_CERT_NAME = "Agent Box server";

/** How long a new certificate is valid. Clients pin it, so no CA limit applies. */
export const SERVER_CERT_DAYS = 3650;

/** A private key and certificate, both PEM. */
export interface TlsIdentity {
  key: string;
  cert: string;
}

export interface CreateIdentityOptions {
  /** The start of the validity period. Default: now. */
  now?: Date;
  /** The validity period in days. Default: `SERVER_CERT_DAYS`. */
  days?: number;
}

/**
 * Creates an ECDSA P-256 key and a self-signed certificate for `localhost`,
 * `127.0.0.1`, and `::1`, valid for server authentication only.
 */
export function createServerIdentity(options: CreateIdentityOptions = {}): TlsIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const now = options.now ?? new Date();
  // An hour of slack covers a client clock slightly behind the server's.
  const notBefore = new Date(now.getTime() - 3600_000);
  const notAfter = new Date(now.getTime() + (options.days ?? SERVER_CERT_DAYS) * 86400_000);
  const name = sequence(set(sequence(oid(OID.commonName), utf8String(SERVER_CERT_NAME))));
  const algorithm = sequence(oid(OID.ecdsaWithSha256));
  const serial = randomBytes(16);
  serial[0] = (serial[0] as number) & 0x7f;
  const altNames = sequence(
    tlv(0x82, Buffer.from("localhost", "ascii")),
    tlv(0x87, Buffer.from([127, 0, 0, 1])),
    tlv(0x87, Buffer.from([...Array(15).fill(0), 1])),
  );
  const extensions = sequence(
    sequence(oid(OID.subjectAltName), octetString(altNames)),
    sequence(oid(OID.extKeyUsage), octetString(sequence(oid(OID.serverAuth)))),
  );
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    sequence(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, extensions),
  );
  const signature = sign("sha256", tbs, privateKey as KeyObject);
  const der = sequence(tbs, algorithm, bitString(signature));
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    cert: pem("CERTIFICATE", der),
  };
}

// ---------------------------------------------------------------------------
// Pinning.

/** The certificate a client accepts from the server, and nothing else. */
export interface ServerPin {
  /** The certificate, PEM. */
  pem: string;
  /** Its SHA-256 fingerprint as Node.js prints it: `AB:CD:...`. */
  fingerprint256: string;
}

/** The pin for a PEM certificate. Throws when the text isn't a certificate. */
export function pinFromPem(certPem: string): ServerPin {
  const cert = new X509Certificate(certPem);
  return { pem: cert.toString(), fingerprint256: cert.fingerprint256 };
}

/**
 * Reads the server's certificate from `file`. Returns `null` when the file
 * doesn't exist, which means the server has never started with this data
 * directory. Throws when the file holds something other than a certificate.
 */
export function readServerPin(file: string): ServerPin | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    return pinFromPem(text);
  } catch {
    throw new Error(`${file} doesn't hold a certificate.`);
  }
}

/** True when a certificate, PEM or DER, is the pinned one. */
export function matchesPin(cert: string | Buffer, pin: ServerPin): boolean {
  try {
    return new X509Certificate(cert).fingerprint256 === pin.fingerprint256;
  } catch {
    return false;
  }
}

/** The error a client reports when the server presents another certificate. */
export class ServerIdentityError extends Error {
  constructor(host: string) {
    super(
      `The server at ${host} presented a certificate other than the one in the data directory's server.crt, so the token wasn't sent. Another program might be listening on the server port.`,
    );
    this.name = "ServerIdentityError";
  }
}

/**
 * The error a client reports when the pinned certificate is outside its
 * validity period by this machine's clock. That points at the clock or an
 * old certificate, not at another program on the port.
 */
export class ServerCertificateDateError extends Error {
  constructor(
    host: string,
    readonly reason: "expired" | "not_yet_valid",
    pin?: ServerPin,
  ) {
    const state = reason === "expired" ? "has expired" : "isn't valid yet";
    let dates = "";
    if (pin) {
      try {
        const cert = new X509Certificate(pin.pem);
        dates = ` It is valid from ${cert.validFrom} to ${cert.validTo}.`;
      } catch {
        // No dates to give.
      }
    }
    super(
      `The certificate in the data directory's server.crt ${state} by this machine's clock, so the token wasn't sent to ${host}.${dates} Check the system clock. The server replaces an expired certificate when it starts.`,
    );
    this.name = "ServerCertificateDateError";
  }
}

/**
 * Turns a certificate failure of a pinned connection into a
 * `ServerIdentityError`, which says what happened in terms of the data
 * directory, or a `ServerCertificateDateError` when the certificate is
 * outside its validity period. `pin`, when given, supplies the dates for
 * that message. Any other error passes unchanged.
 */
export function asIdentityError(err: unknown, host: string, pin?: ServerPin): unknown {
  if (err instanceof ServerIdentityError || err instanceof ServerCertificateDateError) return err;
  const code = String((err as { code?: unknown })?.code ?? "");
  if (code === "CERT_HAS_EXPIRED") return new ServerCertificateDateError(host, "expired", pin);
  if (code === "CERT_NOT_YET_VALID") {
    return new ServerCertificateDateError(host, "not_yet_valid", pin);
  }
  return /CERT|SELF_SIGNED|UNABLE_TO_|ALTNAME/.test(code) ? new ServerIdentityError(host) : err;
}

/**
 * TLS options that trust the pinned certificate and nothing else. Pass them
 * to `https.request`, `tls.connect`, or the `ws` package's `WebSocket`. The
 * handshake fails before any request bytes leave when the server presents
 * another certificate.
 */
export function pinnedTlsOptions(pin: ServerPin): {
  ca: string;
  rejectUnauthorized: true;
  checkServerIdentity: (host: string, cert: PeerCertificate) => Error | undefined;
} {
  return {
    ca: pin.pem,
    rejectUnauthorized: true,
    checkServerIdentity: (host, cert) =>
      cert.fingerprint256 === pin.fingerprint256 ? undefined : new ServerIdentityError(host),
  };
}

function bodyText(body: unknown): string | Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new TypeError("The pinned fetch sends only string and byte bodies.");
}

/**
 * A `fetch` that sends `https` requests only to a server that presents the
 * pinned certificate. `pin` runs for every request, so a certificate the
 * server replaced is read again. Supports what the Agent Box clients use: a
 * method, headers, a string or byte body, and an abort signal.
 */
export function pinnedFetch(pin: () => ServerPin): typeof fetch {
  const pinned = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:") {
      throw new TypeError(`The pinned fetch sends nothing over ${url.protocol}`);
    }
    const current = pin();
    const tls = pinnedTlsOptions(current);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const body = bodyText(init.body);
    const method = (init.method ?? "GET").toUpperCase();
    return new Promise<Response>((resolve, reject) => {
      const req = https.request(
        url,
        { method, headers, signal: init.signal ?? undefined, agent: false, ...tls },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const status = res.statusCode ?? 502;
            const out = new Headers();
            for (const [name, value] of Object.entries(res.headers)) {
              if (Array.isArray(value)) value.forEach((v) => out.append(name, v));
              else if (value !== undefined) out.set(name, String(value));
            }
            const empty = method === "HEAD" || [204, 205, 304].includes(status);
            resolve(
              new Response(empty ? null : Buffer.concat(chunks), {
                status,
                statusText: res.statusMessage ?? "",
                headers: out,
              }),
            );
          });
        },
      );
      req.on("error", (err) => reject(asIdentityError(err, url.host, current)));
      req.end(body);
    });
  };
  return pinned as typeof fetch;
}
