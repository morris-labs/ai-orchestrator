// The hub's listener for GUI apps on other PCs: HTTPS on its own port, bound to
// the same LAN address as the link listener, and off until a GUI code is issued
// or a GUI app is enrolled.
//
// `POST /gui/v1/enroll` takes a one-time code and a public key, and returns a
// client certificate. Every other request needs a client certificate that the
// hub's authority signed, with the GUI prefix, for a client that isn't revoked.
// The check runs for each request, so a revocation applies to the next one, and
// `revoke` closes that client's connections and streams.
//
// An accepted call goes into the API in-process, as a call over a link does, so
// it gets the same routes and the machine proxy to the nodes. The caller header
// marks it, and `api/server.ts` refuses it the routes that manage enrollment or
// hand out a credential. The API's token and session cookie never reach the app.
import { X509Certificate, randomBytes } from "node:crypto";
import https from "node:https";
import type http from "node:http";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import {
  EnrollMachineNameSchema,
  type EnrollmentCode,
  type GuiClient,
  type GuiClientList,
} from "@aio/contracts";
import {
  GUI_CERT_PREFIX,
  GUI_ENROLL_PATH,
  GuiEnrollRequestSchema,
  guiClientProof,
  guiCodeKey,
  guiHubProof,
  type GuiEnrollRequest,
  type GuiEnrollResponse,
} from "@aio/contracts/gui-enroll";
import type { FastifyInstance } from "fastify";
import { WebSocketServer, type WebSocket } from "ws";
import type { SqlDatabase } from "../api/core-interface.js";
import { ApiError, toApiError } from "../api/errors.js";
import { issueGuiCertificate, type HubIdentity } from "./ca.js";
import { createDispatcher } from "./dispatch.js";
import { hostForUrl, readBody, refuseUpgrade, requestPath, sendJson } from "./hub.js";
import type { LinkStream } from "./link.js";
import { LinkError } from "./peer.js";
import {
  GUI_CALLER_PREFIX,
  LINK_CLOSE,
  MAX_LINK_PAYLOAD,
  closeReason,
  sendableCloseCode,
} from "./protocol.js";
import { ENROLLMENT_CODE_TTL_MS, newEnrollmentCode, sameHex } from "./registry.js";

/** The largest enrollment body the listener reads. */
const MAX_ENROLL_BODY = 64 * 1024;
/** The largest API request body the listener reads. */
const MAX_REQUEST_BODY = 64 * 1024 * 1024;
/** Bytes a stream can hold unsent to a slow app before the listener stops reading from the box. */
const STREAM_HIGH_WATER = 1024 * 1024;
/** Milliseconds between `last_seen` writes for one client. */
const SEEN_INTERVAL_MS = 60_000;
/** Milliseconds a revoked stream has to finish its close before the socket ends. */
const REVOKE_GRACE_MS = 1000;

interface RawClient {
  id: string;
  name: string;
  cert_fingerprint: string;
  revoked_at: string | null;
  last_seen: string | null;
  created_at: string;
}

/** The enrolled GUI apps and their one-time codes, in SQLite (migration 8). */
export class GuiRegistry {
  constructor(
    private readonly db: SqlDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): RawClient[] {
    return this.db
      .prepare("SELECT * FROM gui_clients ORDER BY created_at, id")
      .all() as unknown as RawClient[];
  }

  byFingerprint(fingerprint: string): RawClient | undefined {
    return this.db
      .prepare("SELECT * FROM gui_clients WHERE cert_fingerprint = ?")
      .get(fingerprint) as RawClient | undefined;
  }

  byLiveName(name: string): RawClient | undefined {
    return this.db
      .prepare("SELECT * FROM gui_clients WHERE name = ? COLLATE NOCASE AND revoked_at IS NULL")
      .get(name) as RawClient | undefined;
  }

  liveCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM gui_clients WHERE revoked_at IS NULL").get() as {
        n: number;
      }
    ).n;
  }

  add(client: { id: string; name: string; certFingerprint: string }): void {
    this.db
      .prepare(
        "INSERT INTO gui_clients (id, name, cert_fingerprint, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(client.id, client.name, client.certFingerprint, this.now().toISOString());
  }

  seen(id: string): void {
    this.db
      .prepare("UPDATE gui_clients SET last_seen = ? WHERE id = ?")
      .run(this.now().toISOString(), id);
  }

  /** Marks a client revoked. Returns false when it doesn't exist. */
  revoke(id: string): boolean {
    const r = this.db
      .prepare("UPDATE gui_clients SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
      .run(this.now().toISOString(), id);
    return Number(r.changes) > 0;
  }

  /** Stores a new code's key; returns the expiry time. */
  addCode(code: string, ttlMs = ENROLLMENT_CODE_TTL_MS): Date {
    const now = this.now();
    const expires = new Date(now.getTime() + ttlMs);
    this.db.prepare("DELETE FROM gui_enrollment_codes WHERE expires_at < ?").run(now.toISOString());
    this.db
      .prepare(
        "INSERT INTO gui_enrollment_codes (code_key, expires_at, created_at) VALUES (?, ?, ?)",
      )
      .run(guiCodeKey(code), expires.toISOString(), now.toISOString());
    return expires;
  }

  liveCodeKeys(): string[] {
    const rows = this.db
      .prepare("SELECT code_key FROM gui_enrollment_codes WHERE used_at IS NULL AND expires_at > ?")
      .all(this.now().toISOString()) as { code_key: string }[];
    return rows.map((r) => r.code_key);
  }

  /** Marks a code used; returns false when another enrollment used it first. */
  useCode(key: string): boolean {
    const now = this.now().toISOString();
    const r = this.db
      .prepare(
        "UPDATE gui_enrollment_codes SET used_at = ? WHERE code_key = ? AND used_at IS NULL AND expires_at > ?",
      )
      .run(now, key, now);
    return Number(r.changes) > 0;
  }
}

export interface GuiListenerOptions {
  db: SqlDatabase;
  isHub: () => boolean;
  identity: () => Promise<HubIdentity>;
  port: () => number;
  bindHost: () => string | undefined;
  address: () => string | undefined;
  /** The server token, which calls into this machine's API carry. */
  token: string;
  api: () => FastifyInstance | null;
  log: (message: string) => void;
  now?: () => Date;
}

type Refusal = { status: number; message: string };

export class GuiListener {
  readonly registry: GuiRegistry;
  private server: https.Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly sockets = new Set<Duplex>();
  /** The connections and streams of each client, for `revoke`. */
  private readonly connections = new Map<string, Set<Duplex>>();
  private readonly streams = new Map<string, Set<WebSocket>>();
  private readonly lastSeen = new Map<string, number>();
  private listenPort: number | null = null;
  private boundHost: string | null = null;
  private listenError: string | null = null;
  private reconciling: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly opts: GuiListenerOptions) {
    this.registry = new GuiRegistry(opts.db, opts.now);
  }

  get port(): number | null {
    return this.listenPort;
  }

  async start(): Promise<void> {
    await this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), 60_000);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.reconciling;
    await this.stopListening();
  }

  /**
   * Starts or stops the listener: it runs while this machine is a hub and at
   * least one GUI app is enrolled or one code is live.
   */
  reconcile(): Promise<void> {
    this.reconciling = this.reconciling.then(async () => {
      if (this.closed) return;
      try {
        const want =
          this.opts.isHub() &&
          (this.registry.liveCount() > 0 || this.registry.liveCodeKeys().length > 0);
        if (want && this.server && this.opts.bindHost() !== this.boundHost) {
          await this.stopListening();
        }
        if (want && !this.server) await this.listen();
        else if (!want && this.server) await this.stopListening();
        this.listenError = null;
      } catch (err) {
        const message = (err as Error).message;
        if (message !== this.listenError) this.opts.log(`The GUI listener failed: ${message}`);
        this.listenError = message;
      }
    });
    return this.reconciling;
  }

  list(): GuiClientList {
    this.assertHub();
    return { clients: this.registry.list().map(toClient), port: this.listenPort };
  }

  /** Issues a one-time GUI enrollment code and makes sure the listener runs. */
  async issueCode(): Promise<EnrollmentCode> {
    this.assertHub();
    await this.opts.identity();
    const code = newEnrollmentCode();
    const expiresAt = this.registry.addCode(code);
    await this.reconcile();
    if (this.listenPort === null) {
      throw new ApiError(
        "invalid_state",
        this.listenError ?? `The hub can't listen for GUI apps on port ${this.opts.port()}.`,
      );
    }
    const host = this.opts.address() ?? this.boundHost ?? "localhost";
    return {
      code,
      expiresAt: expiresAt.toISOString(),
      hubUrl: `https://${hostForUrl(host)}:${this.listenPort}`,
    };
  }

  /** Revokes a GUI app and closes its connections and streams. */
  async revoke(id: string): Promise<void> {
    this.assertHub();
    if (!this.registry.revoke(id))
      throw new ApiError("not_found", `No GUI client has the id ${id}.`);
    for (const stream of this.streams.get(id) ?? []) {
      stream.close(LINK_CLOSE.revoked, "This app's certificate was revoked.");
      setTimeout(() => stream.terminate(), REVOKE_GRACE_MS).unref();
    }
    this.streams.delete(id);
    for (const socket of this.connections.get(id) ?? []) socket.destroy();
    this.connections.delete(id);
    this.opts.log(`Revoked GUI client ${id}.`);
    await this.reconcile();
  }

  private assertHub(): void {
    if (!this.opts.isHub()) {
      throw new ApiError("invalid_state", "This machine isn't a hub. Manage GUI apps on the hub.");
    }
  }

  private async listen(): Promise<void> {
    const host = this.opts.bindHost();
    if (host === undefined) {
      throw new Error(
        "This machine has no LAN IPv4 address on its default route, so the hub doesn't listen for GUI apps. Set the linkHost setting to the address to listen on.",
      );
    }
    const identity = await this.opts.identity();
    const server = https.createServer(
      {
        key: identity.link.key,
        cert: identity.link.cert,
        ca: [identity.ca.cert],
        requestCert: true,
        // Enrollment comes from an app with no certificate yet; every other
        // request is checked in `authenticate`.
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
      },
      (req, res) => {
        this.serveHttp(req, res).catch((err: unknown) => {
          this.opts.log(`A GUI request failed: ${(err as Error).message}`);
          res.destroy();
        });
      },
    );
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_LINK_PAYLOAD });
    server.on("upgrade", (req, socket, head) => {
      socket.on("error", () => socket.destroy());
      this.serveUpgrade(wss, req, socket, head).catch((err: unknown) => {
        this.opts.log(`A GUI upgrade failed: ${(err as Error).message}`);
        socket.destroy();
      });
    });
    server.on("tlsClientError", () => undefined);
    const wanted = this.opts.port();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(wanted, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    this.listenPort = typeof address === "object" && address ? address.port : wanted;
    this.boundHost = host;
    this.server = server;
    this.wss = wss;
    this.opts.log(`Hub listening for GUI apps on ${hostForUrl(host)}:${this.listenPort}.`);
  }

  private async stopListening(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.listenPort = null;
    this.boundHost = null;
    for (const client of this.wss?.clients ?? []) client.terminate();
    this.wss?.close();
    this.wss = null;
    server.closeAllConnections();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The client behind a request's certificate, or why the request is refused. */
  private authenticate(req: http.IncomingMessage): RawClient | Refusal {
    const socket = req.socket as TLSSocket;
    const cert = socket.getPeerCertificate?.();
    if (!socket.authorized || !cert?.fingerprint256) {
      return { status: 401, message: "This listener needs a client certificate from this hub." };
    }
    const commonName = cert.subject?.CN;
    if (typeof commonName !== "string" || !commonName.startsWith(GUI_CERT_PREFIX)) {
      return { status: 403, message: "This listener takes only a GUI app's certificate." };
    }
    const client = this.registry.byFingerprint(cert.fingerprint256);
    if (!client || commonName !== `${GUI_CERT_PREFIX}${client.id}`) {
      return { status: 401, message: "This hub doesn't know the certificate." };
    }
    if (client.revoked_at !== null) {
      return { status: 403, message: "This app's certificate was revoked." };
    }
    return client;
  }

  private track(client: RawClient, socket: Duplex): void {
    const set = this.connections.get(client.id) ?? new Set<Duplex>();
    this.connections.set(client.id, set);
    if (!set.has(socket)) {
      set.add(socket);
      socket.once("close", () => set.delete(socket));
    }
    const now = Date.now();
    if (now - (this.lastSeen.get(client.id) ?? 0) >= SEEN_INTERVAL_MS) {
      this.lastSeen.set(client.id, now);
      this.registry.seen(client.id);
    }
  }

  private dispatcher(client: RawClient) {
    return createDispatcher({
      api: this.opts.api,
      token: this.opts.token,
      caller: `${GUI_CALLER_PREFIX}${client.id}`,
      internal: new Map(),
    });
  }

  private async serveHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (requestPath(req) === GUI_ENROLL_PATH) return this.serveEnroll(req, res);
    const client = this.authenticate(req);
    if ("status" in client) {
      sendJson(res, client.status, {
        error: { code: "unauthorized", message: client.message },
      });
      return;
    }
    this.track(client, req.socket);
    const target = req.url ?? "/";
    const query = target.indexOf("?");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[name] = value;
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_REQUEST_BODY);
    } catch (err) {
      const failure = toApiError(err);
      sendJson(res, failure.status, failure.toBody());
      return;
    }
    const answer = await this.dispatcher(client).request({
      method: req.method ?? "GET",
      path: query < 0 ? target : target.slice(0, query),
      query: query < 0 ? undefined : target.slice(query + 1),
      headers,
      body,
    });
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  }

  private async serveEnroll(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: { code: "validation", message: "Use POST." } });
      return;
    }
    try {
      const raw = await readBody(req, MAX_ENROLL_BODY);
      const parsed = GuiEnrollRequestSchema.safeParse(JSON.parse(raw.toString() || "{}"));
      if (!parsed.success) {
        throw new ApiError("validation", "The enrollment request doesn't match its schema.");
      }
      sendJson(res, 200, await this.enroll(parsed.data));
    } catch (err) {
      const failure =
        err instanceof ApiError
          ? err
          : new ApiError("validation", "The enrollment request isn't valid JSON.");
      sendJson(res, failure.status, failure.toBody());
    }
  }

  /** Checks an enrollment against the live codes, and signs the app's certificate. */
  async enroll(req: GuiEnrollRequest): Promise<GuiEnrollResponse> {
    const name = EnrollMachineNameSchema.parse(req.name);
    const identity = await this.opts.identity();
    const key = this.registry.liveCodeKeys().find((k) =>
      sameHex(
        guiClientProof(k, {
          hubFingerprint: identity.linkFingerprint,
          nonce: req.nonce,
          name,
          publicKey: req.publicKey,
        }),
        req.proof,
      ),
    );
    if (!key) {
      throw new ApiError(
        "unauthorized",
        "The GUI code is wrong, used, or expired, or something between this PC and the hub changed the connection. Issue a new code on the hub and try again.",
      );
    }
    if (this.registry.byLiveName(name)) {
      throw new ApiError(
        "conflict",
        `A GUI app named ${name} is already enrolled. Enroll with another name, or revoke it on the hub first.`,
      );
    }
    const clientId = `g${randomBytes(8).toString("hex")}`;
    let clientCert: string;
    try {
      clientCert = issueGuiCertificate(identity.ca, clientId, req.publicKey);
    } catch (err) {
      throw new ApiError("validation", (err as Error).message);
    }
    // Last, so a request with a bad key doesn't spend the code.
    if (!this.registry.useCode(key)) {
      throw new ApiError("unauthorized", "Another app used the GUI code first.");
    }
    this.registry.add({
      id: clientId,
      name,
      certFingerprint: new X509Certificate(clientCert).fingerprint256,
    });
    this.opts.log(`Enrolled GUI app ${name} as ${clientId}.`);
    void this.reconcile();
    const caCert = identity.ca.cert;
    const hubCert = identity.link.cert;
    return {
      clientId,
      name,
      clientCert,
      caCert,
      hubCert,
      proof: guiHubProof(key, { nonce: req.nonce, clientId, clientCert, caCert, hubCert }),
    };
  }

  private async serveUpgrade(
    wss: WebSocketServer,
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const client = this.authenticate(req);
    if ("status" in client) return refuseUpgrade(socket, client.status, client.message);
    const target = req.url ?? "/";
    const query = target.indexOf("?");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[name] = value;
    }
    let stream: LinkStream;
    try {
      stream = await this.dispatcher(client).openStream({
        path: query < 0 ? target : target.slice(0, query),
        query: query < 0 ? undefined : target.slice(query + 1),
        headers,
      });
    } catch (err) {
      const status = err instanceof LinkError ? (err.status ?? 502) : 502;
      return refuseUpgrade(socket, status, (err as Error).message);
    }
    // A revocation can land while the stream opened.
    if (this.registry.byFingerprint(client.cert_fingerprint)?.revoked_at !== null) {
      stream.close(LINK_CLOSE.revoked, "This app's certificate was revoked.");
      return refuseUpgrade(socket, 403, "This app's certificate was revoked.");
    }
    // `handleUpgrade` calls back synchronously or not at all: it skips the
    // callback when the socket already ended, the handshake is invalid, or the
    // server is closing. Nothing else owns the stream in those cases.
    let bridged = false;
    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.track(client, req.socket);
        this.bridge(client, ws, stream);
        bridged = true;
      });
    } finally {
      if (!bridged) stream.close(1001, "The app's upgrade didn't finish.");
    }
  }

  /** Joins an app's WebSocket to a stream into the API. */
  private bridge(client: RawClient, ws: WebSocket, stream: LinkStream): void {
    const open = this.streams.get(client.id) ?? new Set<WebSocket>();
    this.streams.set(client.id, open);
    open.add(ws);
    const paused = stream as LinkStream & { pause?(): void; resume?(): void };
    ws.on("error", () => ws.terminate());
    ws.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      stream.send(bytes, isBinary);
    });
    ws.on("close", (code, reason) => {
      open.delete(ws);
      stream.close(sendableCloseCode(code), reason.toString());
    });
    stream.onMessage((data, binary) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(data, { binary }, () => {
        if (ws.bufferedAmount < STREAM_HIGH_WATER) paused.resume?.();
      });
      if (ws.bufferedAmount >= STREAM_HIGH_WATER) paused.pause?.();
    });
    stream.onClose((code, reason) => {
      if (ws.readyState === ws.OPEN) ws.close(sendableCloseCode(code), closeReason(reason));
    });
  }
}

function toClient(row: RawClient): GuiClient {
  return {
    id: row.id,
    name: row.name,
    status: row.revoked_at === null ? "active" : "revoked",
    createdAt: row.created_at,
    lastSeen: row.last_seen,
    revokedAt: row.revoked_at,
  };
}
