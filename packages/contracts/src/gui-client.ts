// A GUI app's side of an enrolled hub, for an Electron main process. Node.js
// only: import it as `@aio/contracts/gui-client`, never from page code.
//
// The app generates its private key here and never sends it. Chromium can't
// present a client certificate from a file, so the main process runs a small
// proxy on a loopback port. The proxy holds the key and pins the hub, and the
// window and the main process's own clients talk to the proxy. The renderer
// never sees the key or the certificate: it gets a token that lasts for this
// launch and works only on the proxy, and trades it for a session cookie, as it
// does with a local server.
//
// One folder holds the enrollment for both apps, so one code enrolls this PC:
//
//   client.key        The private key, mode 0600.
//   client.crt        The client certificate the hub signed.
//   hub-ca.crt        The hub's authority.
//   hub.crt           The hub's pinned certificate.
//   connection.json   The local or hub setting, and the enrollment's details.
//   enrollment.json   Optional: a code from an installer, removed at first read.
import {
  X509Certificate,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import {
  GUI_CERT_PREFIX,
  GUI_ENROLL_PATH,
  GuiEnrollResponseSchema,
  guiClientProof,
  guiCodeKey,
  guiHubProof,
} from "./gui-enroll.js";

/** The folder under the OS's application data folder that holds the enrollment. */
export const GUI_CLIENT_FOLDER = "ai-orchestrator-hub-client";

/** The enrollment folder. `AIO_GUI_CLIENT_DIR` replaces it for a test or a wrapper. */
export function guiClientDir(
  appData: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return env.AIO_GUI_CLIENT_DIR || join(appData, GUI_CLIENT_FOLDER);
}

export interface HubEnrollment {
  hubUrl: string;
  clientId: string;
  name: string;
  clientKey: string;
  clientCert: string;
  caCert: string;
  hubCert: string;
}

export interface GuiConnection {
  mode: "local" | "hub";
  /** The enrollment, or `null` when this PC has none. */
  hub: HubEnrollment | null;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function writeFileAtomic(file: string, text: string, mode: number): void {
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { mode, flag: "wx" });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

/** Reads the connection setting. A missing or damaged enrollment reads as none. */
export function readConnection(dir: string): GuiConnection {
  let saved: { mode?: unknown; hubUrl?: unknown; clientId?: unknown; name?: unknown } = {};
  try {
    saved = JSON.parse(readText(join(dir, "connection.json")) ?? "{}") as typeof saved;
  } catch {
    saved = {};
  }
  const [clientKey, clientCert, caCert, hubCert] = [
    "client.key",
    "client.crt",
    "hub-ca.crt",
    "hub.crt",
  ].map((f) => readText(join(dir, f)));
  const hub =
    clientKey &&
    clientCert &&
    caCert &&
    hubCert &&
    typeof saved.hubUrl === "string" &&
    typeof saved.clientId === "string"
      ? {
          hubUrl: saved.hubUrl,
          clientId: saved.clientId,
          name: typeof saved.name === "string" ? saved.name : saved.clientId,
          clientKey,
          clientCert,
          caCert,
          hubCert,
        }
      : null;
  return { mode: saved.mode === "hub" && hub ? "hub" : "local", hub };
}

function writeConnectionFile(dir: string, mode: "local" | "hub", hub: HubEnrollment | null): void {
  writeFileAtomic(
    join(dir, "connection.json"),
    `${JSON.stringify({
      mode,
      ...(hub ? { hubUrl: hub.hubUrl, clientId: hub.clientId, name: hub.name } : {}),
    })}\n`,
    0o600,
  );
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** Stores local or hub as the connection. Hub needs an enrollment. */
export function setConnectionMode(dir: string, mode: "local" | "hub"): void {
  const { hub } = readConnection(dir);
  if (mode === "hub" && !hub) throw new Error("This PC isn't enrolled with a hub.");
  ensureDir(dir);
  writeConnectionFile(dir, mode, hub);
}

/** Removes the enrollment and its private key, and goes back to the local server. */
export function forgetHub(dir: string): void {
  for (const file of ["client.key", "client.crt", "hub-ca.crt", "hub.crt", "connection.json"]) {
    rmSync(join(dir, file), { force: true });
  }
}

/** Reads and removes a code that an installer left. The code never stays on disk. */
export function takeInstallerEnrollment(
  dir: string,
): { hubUrl: string; code: string; name?: string } | null {
  const file = join(dir, "enrollment.json");
  const text = readText(file);
  if (text === null) return null;
  rmSync(file, { force: true });
  try {
    const value = JSON.parse(text) as { hubUrl?: unknown; code?: unknown; name?: unknown };
    if (typeof value.hubUrl !== "string" || typeof value.code !== "string") return null;
    return {
      hubUrl: value.hubUrl,
      code: value.code,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
    };
  } catch {
    return null;
  }
}

function postOver(
  socket: tls.TLSSocket,
  url: URL,
  body: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: "POST",
        path: GUI_ENROLL_PATH,
        headers: {
          host: url.host,
          connection: "close",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        createConnection: () => socket,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/**
 * Enrolls this PC with a hub: generates the key, proves the code over the
 * certificate the hub presents, checks the hub's proof, pins the hub, and stores
 * the result with hub as the connection. On any failure nothing changes.
 */
export async function enrollWithHub(
  dir: string,
  input: { hubUrl: string; code: string; name: string },
): Promise<HubEnrollment> {
  let url: URL;
  try {
    url = new URL(input.hubUrl);
  } catch {
    throw new Error(`${input.hubUrl} isn't a URL.`);
  }
  if (url.protocol !== "https:") throw new Error("The hub URL must start with https://.");
  const key = guiCodeKey(input.code);
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const clientKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }) as string;
  const nonce = randomBytes(32).toString("hex");
  const host = url.hostname.replace(/^\[|\]$/g, "");

  // Trust on first use: the proof binds the code to the certificate seen on
  // this very connection.
  const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
    const s = tls.connect({
      host,
      port: Number(url.port || 443),
      servername: /^[\d.]+$|:/.test(host) ? undefined : host,
      rejectUnauthorized: false,
    });
    s.setTimeout(15_000, () => s.destroy(new Error("The hub didn't answer in time.")));
    s.once("secureConnect", () => resolve(s));
    s.once("error", reject);
  }).catch((err: Error) => {
    throw new Error(`Can't reach the hub at ${input.hubUrl}: ${err.message}`);
  });
  const seen = socket.getPeerCertificate()?.fingerprint256;
  if (!seen) {
    socket.destroy();
    throw new Error("The hub presented no certificate.");
  }
  const { status, text } = await postOver(
    socket,
    url,
    JSON.stringify({
      name: input.name,
      publicKey,
      nonce,
      proof: guiClientProof(key, { hubFingerprint: seen, nonce, name: input.name, publicKey }),
    }),
  ).finally(() => socket.destroy());
  if (status !== 200) {
    let message = `The hub refused the enrollment with status ${status}.`;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      // Keep the status message.
    }
    throw new Error(message);
  }
  const answer = GuiEnrollResponseSchema.parse(JSON.parse(text));
  const expected = guiHubProof(key, {
    nonce,
    clientId: answer.clientId,
    clientCert: answer.clientCert,
    caCert: answer.caCert,
    hubCert: answer.hubCert,
  });
  const issued = new X509Certificate(answer.clientCert);
  const ok =
    expected.length === answer.proof.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(answer.proof)) &&
    new X509Certificate(answer.hubCert).fingerprint256 === seen &&
    issued.subject.includes(`CN=${GUI_CERT_PREFIX}${answer.clientId}`) &&
    createPublicKey(publicKey).equals(issued.publicKey);
  if (!ok) throw new Error("The hub's answer doesn't match the code. Nothing changed.");

  ensureDir(dir);
  const hub: HubEnrollment = {
    hubUrl: url.origin,
    clientId: answer.clientId,
    name: answer.name,
    clientKey,
    clientCert: answer.clientCert,
    caCert: answer.caCert,
    hubCert: answer.hubCert,
  };
  writeFileAtomic(join(dir, "client.key"), clientKey, 0o600);
  writeFileAtomic(join(dir, "client.crt"), hub.clientCert, 0o644);
  writeFileAtomic(join(dir, "hub-ca.crt"), hub.caCert, 0o644);
  writeFileAtomic(join(dir, "hub.crt"), hub.hubCert, 0o644);
  writeConnectionFile(dir, "hub", hub);
  return hub;
}

/** The session cookie on the proxy, apart from the server's own on the same host. */
const PROXY_COOKIE = "aio_hub_session";
const SESSION_PATH = "/api/v1/auth/session";
/** Headers that describe one connection, or this proxy's credentials. */
const DROPPED = new Set([
  "authorization",
  "cookie",
  "origin",
  "host",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface HubProxy {
  /** The proxy's origin, such as `http://127.0.0.1:43127`. */
  url: string;
  /** Works on the proxy for this launch only. It isn't a credential for the hub. */
  token: string;
  close(): Promise<void>;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True for what a page needs before it has a token: the pages and the health route. */
function isPublic(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  // A dot segment or an escape could turn a page path into an API path on the hub.
  if (path.includes("..") || path.includes("%") || path.includes("\\")) return false;
  return path.startsWith("/boxes/") || path.startsWith("/review/") || path === "/api/v1/health";
}

function isPage(path: string): boolean {
  return path.startsWith("/boxes/") || path.startsWith("/review/");
}

/** Starts the loopback proxy to an enrolled hub. */
export async function startHubProxy(hub: HubEnrollment): Promise<HubProxy> {
  const target = new URL(hub.hubUrl);
  const token = randomBytes(32).toString("hex");
  const cookie = randomBytes(32).toString("hex");
  const pinned = new X509Certificate(hub.hubCert).fingerprint256;
  const tlsOptions = {
    key: hub.clientKey,
    cert: hub.clientCert,
    ca: hub.caCert,
    rejectUnauthorized: true as const,
    checkServerIdentity: (_host: string, cert: tls.PeerCertificate) =>
      cert.fingerprint256 === pinned
        ? undefined
        : new Error("The hub presented a certificate other than the one this PC pinned."),
  };
  const agent = new https.Agent({ keepAlive: true, ...tlsOptions });
  const upstream = {
    protocol: target.protocol,
    hostname: target.hostname.replace(/^\[|\]$/g, ""),
    port: Number(target.port || 443),
  };
  let port = 0;
  const open = new Set<Duplex>();

  const headersFor = (req: http.IncomingMessage): http.OutgoingHttpHeaders => {
    const out: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!DROPPED.has(name)) out[name] = value;
    }
    return out;
  };
  const authorized = (req: http.IncomingMessage): boolean => {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
    if (bearer && same((bearer[1] as string).trim(), token)) return true;
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [name, value] = part.trim().split("=");
      if (name === PROXY_COOKIE && value && same(value, cookie)) return true;
    }
    return false;
  };
  const ownHost = (req: http.IncomingMessage) => req.headers.host === `127.0.0.1:${port}`;
  const send = (res: http.ServerResponse, status: number, code: string, message: string) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code, message } }));
  };

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] as string;
    // A foreign page can reach loopback with a name it controls.
    if (!ownHost(req))
      return send(res, 403, "unauthorized", "This proxy serves only its own host.");
    if (req.method === "POST" && path === SESSION_PATH) {
      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
      if (!bearer || !same((bearer[1] as string).trim(), token)) {
        return send(res, 401, "unauthorized", "Setting the session cookie needs the token.");
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "set-cookie": `${PROXY_COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=/`,
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (!isPublic(req.method ?? "GET", path) && !authorized(req)) {
      return send(res, 401, "unauthorized", "Missing or wrong token for this app's hub proxy.");
    }
    const out = https.request(
      { ...upstream, agent, method: req.method, path: req.url, headers: headersFor(req) },
      (answer) => {
        const headers = { ...answer.headers };
        delete headers["set-cookie"];
        res.writeHead(answer.statusCode ?? 502, headers);
        answer.pipe(res);
      },
    );
    out.on("error", (err) => {
      // A page load that fails lets the window show its offline page.
      if (isPage(path) || res.headersSent) res.destroy();
      else send(res, 502, "hub_unreachable", `Can't reach the hub: ${err.message}`);
    });
    req.pipe(out);
  });

  server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    const refuse = (line: string) => {
      socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const origin = req.headers.origin;
    if (!ownHost(req) || (origin !== undefined && origin !== `http://127.0.0.1:${port}`)) {
      return refuse("403 Forbidden");
    }
    if (!authorized(req)) return refuse("401 Unauthorized");
    const out = https.request({
      ...upstream,
      ...tlsOptions,
      agent: false,
      method: "GET",
      path: req.url,
      headers: {
        ...headersFor(req),
        connection: "Upgrade",
        upgrade: "websocket",
      },
    });
    out.on("upgrade", (answer, hubSocket, hubHead) => {
      const lines = ["HTTP/1.1 101 Switching Protocols"];
      for (let i = 0; i < answer.rawHeaders.length; i += 2) {
        lines.push(`${answer.rawHeaders[i]}: ${answer.rawHeaders[i + 1]}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (hubHead.length > 0) socket.write(hubHead);
      if (head.length > 0) hubSocket.write(head);
      open.add(socket);
      socket.once("close", () => open.delete(socket));
      hubSocket.on("error", () => socket.destroy());
      hubSocket.once("close", () => socket.destroy());
      socket.once("close", () => hubSocket.destroy());
      socket.pipe(hubSocket);
      hubSocket.pipe(socket);
    });
    out.on("response", (answer) => {
      refuse(`${answer.statusCode ?? 502} ${answer.statusMessage ?? "Refused"}`);
      answer.resume();
    });
    out.on("error", () => refuse("502 Bad Gateway"));
    out.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    async close() {
      agent.destroy();
      for (const socket of open) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
