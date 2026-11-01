// The server's TLS identity and the client side of pinning it.
//
// The server serves its API over HTTPS with a self-signed certificate that
// it creates in its data directory on first start. Every client reads that
// certificate from the same directory and refuses a server that presents any
// other, so a process that binds the server port while the server is down
// never receives the token.
//
// This module uses Node.js built-ins. Import it as `@aio/contracts/tls`
// from Node.js and Electron main processes only, never from page code.
//
// The certificate is built with `node:crypto` and a small DER encoder rather
// than a dependency or the `openssl` command: the fields are fixed, the
// encoder is short enough to read in one sitting, and the tests check the
// result with OpenSSL through a real TLS handshake.
import {
  X509Certificate,
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
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
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  clientAuth: "1.3.6.1.5.5.7.3.2",
} as const;

/** A PEM block of `label` around DER bytes. */
function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** An extension; a critical one carries the BOOLEAN TRUE between its OID and value. */
function extension(id: string, value: Buffer, critical = false): Buffer {
  return critical
    ? sequence(oid(id), tlv(0x01, Buffer.from([0xff])), octetString(value))
    : sequence(oid(id), octetString(value));
}

/** The key usage BIT STRING for the named bits, with the unused bits counted as DER wants. */
function keyUsageBits(bits: readonly number[]): Buffer {
  let value = 0;
  for (const bit of bits) value |= 0x80 >> bit;
  let unused = 0;
  while (unused < 7 && !(value & (1 << unused))) unused++;
  return tlv(0x03, Buffer.from([unused, value]));
}

/** A key identifier: the SHA-1 hash of the key's DER encoding (RFC 7093, method 4 style). */
function keyIdentifier(publicKey: KeyObject): Buffer {
  return createHash("sha1")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest();
}

/** An X.509 name with one common name. */
function x509Name(commonName: string): Buffer {
  return sequence(set(sequence(oid(OID.commonName), utf8String(commonName))));
}

/** The DER bytes of an IP address, or `null` when `text` isn't one. */
function ipBytes(text: string): Buffer | null {
  if (isIPv4(text)) return Buffer.from(text.split(".").map(Number));
  if (!isIPv6(text)) return null;
  const [head = "", tail = ""] = text.split("::") as [string, string?];
  const parts = (s: string) => (s === "" ? [] : s.split(":"));
  const left = parts(head);
  const right = text.includes("::") ? parts(tail) : [];
  const fill = Array<string>(8 - left.length - right.length).fill("0");
  const groups = text.includes("::") ? [...left, ...fill, ...right] : left;
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

// ---------------------------------------------------------------------------
// Certificates.

/** What a certificate's key may authenticate. */
export type CertificateUsage = "serverAuth" | "clientAuth";

export interface CertificateOptions {
  /** The subject's common name. */
  commonName: string;
  /** The subject's public key. */
  publicKey: KeyObject;
  /** The key that signs: the subject's own private key for a self-signed certificate. */
  signingKey: KeyObject;
  /**
   * The issuer: its common name and public key. Absent means self-signed,
   * with the subject as its own issuer.
   */
  issuer?: { commonName: string; publicKey: KeyObject };
  /**
   * `true` makes a certificate authority that may sign others; `false` marks
   * an end-entity certificate. Absent adds neither basic constraints nor key
   * usage, as the server's own self-signed certificate has always done.
   */
  ca?: boolean;
  /** The extended key usages. Default: none listed. */
  usages?: readonly CertificateUsage[];
  /** DNS names and IP addresses for the subject alternative name. */
  altNames?: readonly string[];
  /** The start of the validity period. Default: now. */
  now?: Date;
  /** The validity period in days. Default: `SERVER_CERT_DAYS`. */
  days?: number;
  /** Adds the subject and authority key identifiers. Default: true when `ca` is set. */
  keyIdentifiers?: boolean;
}

/**
 * Builds and signs an X.509 v3 certificate with an ECDSA P-256 key and
 * SHA-256, and returns it as PEM. It covers the certificates AI Orchestrator
 * makes: the server's self-signed one, and the hub's certificate authority
 * with the link certificates it signs.
 */
export function createCertificate(options: CertificateOptions): string {
  const now = options.now ?? new Date();
  // An hour of slack covers a client clock slightly behind the server's.
  const notBefore = new Date(now.getTime() - 3600_000);
  const notAfter = new Date(now.getTime() + (options.days ?? SERVER_CERT_DAYS) * 86400_000);
  const subject = x509Name(options.commonName);
  const issuer = options.issuer ? x509Name(options.issuer.commonName) : subject;
  const issuerKey = options.issuer?.publicKey ?? options.publicKey;
  const algorithm = sequence(oid(OID.ecdsaWithSha256));
  const serial = randomBytes(16);
  serial[0] = (serial[0] as number) & 0x7f;

  const extensions: Buffer[] = [];
  if (options.ca !== undefined) {
    extensions.push(
      extension(
        OID.basicConstraints,
        options.ca ? sequence(tlv(0x01, Buffer.from([0xff]))) : sequence(),
        true,
      ),
      // keyCertSign (5) and cRLSign (6) for an authority, digitalSignature (0) otherwise.
      extension(OID.keyUsage, keyUsageBits(options.ca ? [5, 6] : [0]), true),
    );
  }
  if (options.keyIdentifiers ?? options.ca !== undefined) {
    extensions.push(
      extension(OID.subjectKeyIdentifier, octetString(keyIdentifier(options.publicKey))),
      extension(OID.authorityKeyIdentifier, sequence(tlv(0x80, keyIdentifier(issuerKey)))),
    );
  }
  const altNames = (options.altNames ?? []).map((name) => {
    const ip = ipBytes(name);
    return ip ? tlv(0x87, ip) : tlv(0x82, Buffer.from(name, "ascii"));
  });
  if (altNames.length > 0) extensions.push(extension(OID.subjectAltName, sequence(...altNames)));
  if (options.usages && options.usages.length > 0) {
    extensions.push(
      extension(OID.extKeyUsage, sequence(...options.usages.map((u) => oid(OID[u])))),
    );
  }

  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    issuer,
    sequence(time(notBefore), time(notAfter)),
    subject,
    options.publicKey.export({ type: "spki", format: "der" }),
    ...(extensions.length > 0 ? [explicit(3, sequence(...extensions))] : []),
  );
  const signature = sign("sha256", tbs, options.signingKey);
  return pem("CERTIFICATE", sequence(tbs, algorithm, bitString(signature)));
}

/** The common name of the server's certificate. */
export const SERVER_CERT_NAME = "AI Orchestrator server";

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
  const cert = createCertificate({
    commonName: SERVER_CERT_NAME,
    publicKey,
    signingKey: privateKey,
    usages: ["serverAuth"],
    altNames: ["localhost", "127.0.0.1", "::1"],
    now: options.now,
    days: options.days,
  });
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, cert };
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
 * server replaced is read again. Supports what the AI Orchestrator clients use: a
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
