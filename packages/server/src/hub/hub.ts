// The hub side of multi-host: the link listener on its own port, the
// enrollment endpoint, the machine registry, and the links of the nodes that
// are connected.
//
// The listener serves HTTPS with the hub's link certificate on every
// interface, and asks every client for a certificate without requiring one:
// enrollment comes from a node that has none yet. The link upgrade then
// requires a certificate that the hub's authority signed, for a machine that
// is enrolled and not revoked.
import { randomBytes } from "node:crypto";
import https from "node:https";
import type http from "node:http";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { X509Certificate } from "node:crypto";
import { MachineNameSchema, type EnrollmentCode, type Machine } from "@aio/contracts";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../api/errors.js";
import { issueNodeCertificate, loadOrCreateHubIdentity, type HubIdentity } from "./ca.js";
import { createDispatcher, type InternalHandler } from "./dispatch.js";
import type { LinkRequest, NodeLink } from "./link.js";
import { LinkPeer, rawText } from "./peer.js";
import {
  LINK_CLOSE,
  LINK_PATHS,
  machinePlatform,
  parseFrame,
  protocolMismatch,
  type LinkHello,
} from "./protocol.js";
import {
  MachineRegistry,
  hubProof,
  newEnrollmentCode,
  nodeProof,
  sameHex,
  type MachineRow,
} from "./registry.js";
import type { SqlDatabase } from "../api/core-interface.js";

/** The largest enrollment body the hub reads. */
const MAX_ENROLL_BODY = 64 * 1024;
/** The largest link frame either end accepts. */
export const MAX_LINK_FRAME = 64 * 1024 * 1024;

export const EnrollRequestSchema = z.object({
  name: MachineNameSchema,
  publicKey: z.string().min(1).max(4096),
  nonce: z.string().regex(/^[0-9a-f]{32,128}$/),
  proof: z.string().regex(/^[0-9a-f]{64}$/),
});
export type EnrollRequest = z.infer<typeof EnrollRequestSchema>;

export const EnrollResponseSchema = z.object({
  machineId: z.string(),
  name: z.string(),
  clientCert: z.string(),
  caCert: z.string(),
  hubCert: z.string(),
  proof: z.string(),
});
export type EnrollResponse = z.infer<typeof EnrollResponseSchema>;

export interface LinkTiming {
  /** Milliseconds between pings on a link. Default 15 seconds. */
  pingMs?: number;
  /** Milliseconds a request over a link waits for its answer. Default 60 seconds. */
  timeoutMs?: number;
  /** Milliseconds to wait for the other end's hello. Default 10 seconds. */
  helloMs?: number;
}

export interface HubOptions {
  /** `DATA_DIR/hub`, where the authority and the link certificate live. */
  dir: string;
  db: SqlDatabase;
  /** Whether this machine may act as a hub now: its role is `hub` or `both`. */
  isHub: () => boolean;
  /** The hello this hub sends. */
  hello: () => LinkHello;
  /** The port to listen on; 0 picks a free one. */
  port: () => number;
  /** The address to bind. Default: every interface. */
  bindHost?: string;
  /** The host name nodes use in the hub URL. */
  address: () => string;
  /** The server token, for requests that nodes send into this machine's API. */
  token: string;
  api: () => FastifyInstance | null;
  /** The link handlers nodes may call, by `METHOD /path`. */
  internal: ReadonlyMap<string, InternalHandler>;
  /** Whether a node may call this API path over its link. */
  allowNodeRequest: (req: { method: string; path: string }, machineId: string) => boolean;
  timing?: LinkTiming;
  log: (message: string) => void;
  /** Called when a node links or unlinks. */
  onChange?: () => void;
  now?: () => Date;
}

/** The answer to a refused upgrade. */
function refuseUpgrade(socket: Duplex, status: number, message: string): void {
  const reason = { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found" }[status] ?? "Error";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ApiError("validation", "The request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Waits for the other end's hello, the first frame on a new link. */
export function awaitHello(
  socket: WebSocket,
  timeoutMs: number,
): Promise<{ hello: LinkHello } | { refused: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("The other end didn't say hello in time."));
    }, timeoutMs);
    timer.unref();
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      cleanup();
      const frame = isBinary ? null : parseFrame(rawText(data));
      if (frame?.type === "hello") resolve({ hello: frame });
      else if (frame?.type === "refuse") resolve({ refused: frame.reason });
      else reject(new Error("The first frame on the link wasn't a hello."));
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`The link closed before the hello (${code} ${reason.toString()}).`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.on("close", onClose);
  });
}

export class Hub {
  readonly registry: MachineRegistry;
  private readonly peers = new Map<string, LinkPeer>();
  private identity: HubIdentity | null = null;
  private server: https.Server | null = null;
  private wss: WebSocketServer | null = null;
  private listenPort: number | null = null;
  private reconciling: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly opts: HubOptions) {
    this.registry = new MachineRegistry(opts.db, opts.now);
  }

  /** The port the link listener is bound to, or `null` while it isn't listening. */
  get port(): number | null {
    return this.listenPort;
  }

  /** Starts the listener when it should run, and checks again every minute. */
  async start(): Promise<void> {
    await this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), 60_000);
    this.timer.unref();
  }

  /** The link to a connected node. */
  get(machineId: string): NodeLink | undefined {
    const peer = this.peers.get(machineId);
    return peer?.isOpen ? peer : undefined;
  }

  /** The ids of the connected nodes. */
  list(): string[] {
    return [...this.peers.entries()].filter(([, p]) => p.isOpen).map(([id]) => id);
  }

  /** The hello of a connected node, with its capabilities. */
  helloOf(machineId: string): LinkHello | undefined {
    return this.peers.get(machineId)?.hello;
  }

  /**
   * Starts or stops the listener: it runs while this machine is a hub and
   * at least one machine was enrolled or one code is live. A revoked machine
   * counts, so that it hears that it was revoked rather than finding no
   * listener.
   */
  reconcile(): Promise<void> {
    this.reconciling = this.reconciling.then(async () => {
      if (this.closed) return;
      const want =
        this.opts.isHub() &&
        (this.registry.count() > 0 || this.registry.liveCodeKeys().length > 0);
      try {
        if (want && !this.server) await this.listen();
        else if (!want && this.server) await this.stopListening();
      } catch (err) {
        this.opts.log(`The hub link listener failed: ${(err as Error).message}`);
      }
    });
    return this.reconciling;
  }

  /** Issues a one-time enrollment code and makes sure the listener runs. */
  async issueCode(): Promise<EnrollmentCode> {
    if (!this.opts.isHub()) {
      throw new ApiError(
        "invalid_state",
        "This machine isn't a hub. Set its role to hub or both to enroll machines.",
      );
    }
    await this.ensureIdentity();
    const code = newEnrollmentCode();
    const expiresAt = this.registry.addCode(code);
    await this.reconcile();
    if (this.listenPort === null) {
      throw new ApiError(
        "invalid_state",
        `The hub can't listen for node links on port ${this.opts.port()}. See the server log.`,
      );
    }
    return {
      code,
      expiresAt: expiresAt.toISOString(),
      hubUrl: `https://${hostForUrl(this.opts.address())}:${this.listenPort}`,
    };
  }

  /** Revokes a machine and closes its link. */
  async revoke(id: string): Promise<void> {
    if (!this.opts.isHub()) {
      throw new ApiError("invalid_state", "Revoke machines on the hub.");
    }
    if (!this.registry.revoke(id)) throw new ApiError("not_found", `No machine has the id ${id}.`);
    const peer = this.peers.get(id);
    if (peer) {
      this.peers.delete(id);
      peer.close(LINK_CLOSE.revoked, "This machine's certificate was revoked.");
    }
    this.opts.log(`Revoked machine ${id}.`);
    this.opts.onChange?.();
    await this.reconcile();
  }

  /** The enrolled machines as the API lists them. */
  machines(): Machine[] {
    const now = (this.opts.now ?? (() => new Date()))().toISOString();
    return this.registry.list().map((row) => this.toMachine(row, now));
  }

  private toMachine(row: MachineRow, now: string): Machine {
    const online = this.get(row.id) !== undefined && row.revokedAt === null;
    const status: Machine["status"] =
      row.revokedAt !== null ? "revoked" : online ? "online" : row.lastSeen === null ? "enrolling" : "offline";
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      status,
      isLocal: false,
      serverVersion: row.serverVersion,
      protocol: row.protocol,
      capabilities: row.capabilities,
      lastSeen: online ? now : row.lastSeen,
      platform: row.platform,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.reconciling;
    await this.stopListening();
  }

  private async ensureIdentity(): Promise<HubIdentity> {
    this.identity ??= await loadOrCreateHubIdentity(this.opts.dir);
    return this.identity;
  }

  private async listen(): Promise<void> {
    const identity = await this.ensureIdentity();
    const server = https.createServer(
      {
        key: identity.link.key,
        cert: identity.link.cert,
        ca: [identity.ca.cert],
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
      },
      (req, res) => void this.serveHttp(req, res),
    );
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_LINK_FRAME });
    server.on("upgrade", (req, socket, head) => this.serveUpgrade(wss, req, socket, head));
    server.on("tlsClientError", () => undefined);
    const wanted = this.opts.port();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(wanted, this.opts.bindHost ?? "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    this.listenPort = typeof address === "object" && address ? address.port : wanted;
    this.server = server;
    this.wss = wss;
    this.opts.log(`Hub listening for node links on port ${this.listenPort}.`);
  }

  private async stopListening(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.listenPort = null;
    for (const peer of this.peers.values()) peer.close(1001, "The hub is stopping.");
    this.peers.clear();
    for (const client of this.wss?.clients ?? []) client.terminate();
    this.wss?.close();
    this.wss = null;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async serveHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "https://hub.invalid");
    if (url.pathname !== LINK_PATHS.enroll) {
      sendJson(res, 404, { error: { code: "not_found", message: "No such link route." } });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: { code: "validation", message: "Use POST." } });
      return;
    }
    try {
      const raw = await readBody(req, MAX_ENROLL_BODY);
      const parsed = EnrollRequestSchema.safeParse(JSON.parse(raw.toString() || "{}"));
      if (!parsed.success) {
        throw new ApiError("validation", "The enrollment request doesn't match its schema.");
      }
      sendJson(res, 200, await this.enroll(parsed.data));
    } catch (err) {
      const failure = err instanceof ApiError ? err : new ApiError("validation", "The enrollment request isn't valid JSON.");
      sendJson(res, failure.status, failure.toBody());
    }
  }

  /** Checks an enrollment against the live codes, and signs the node's certificate. */
  async enroll(req: EnrollRequest): Promise<EnrollResponse> {
    const identity = await this.ensureIdentity();
    const key = this.registry
      .liveCodeKeys()
      .find((k) =>
        sameHex(
          nodeProof(k, {
            hubFingerprint: identity.linkFingerprint,
            nonce: req.nonce,
            name: req.name,
            publicKey: req.publicKey,
          }),
          req.proof,
        ),
      );
    if (!key) {
      throw new ApiError(
        "unauthorized",
        "The enrollment code is wrong, used, or expired, or something between this machine and the hub changed the connection. Issue a new code on the hub and try again.",
      );
    }
    const taken = this.registry.byLiveName(req.name);
    if (taken) {
      throw new ApiError(
        "conflict",
        `A machine named ${req.name} is already enrolled. Join with another name, or revoke ${taken.id} on the hub first.`,
      );
    }
    if (!this.registry.useCode(key)) {
      throw new ApiError("unauthorized", "The enrollment code was used by another machine.");
    }
    const machineId = `m${randomBytes(8).toString("hex")}`;
    let clientCert: string;
    try {
      clientCert = issueNodeCertificate(identity.ca, machineId, req.publicKey);
    } catch (err) {
      throw new ApiError("validation", (err as Error).message);
    }
    this.registry.add({
      id: machineId,
      name: req.name,
      certFingerprint: new X509Certificate(clientCert).fingerprint256,
    });
    this.opts.log(`Enrolled machine ${req.name} as ${machineId}.`);
    this.opts.onChange?.();
    void this.reconcile();
    return {
      machineId,
      name: req.name,
      clientCert,
      caCert: identity.ca.cert,
      hubCert: identity.link.cert,
      proof: hubProof(key, {
        nonce: req.nonce,
        machineId,
        clientCert,
        hubCert: identity.link.cert,
      }),
    };
  }

  private serveUpgrade(
    wss: WebSocketServer,
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    const url = new URL(req.url ?? "/", "https://hub.invalid");
    if (url.pathname !== LINK_PATHS.connect) return refuseUpgrade(socket, 404, "No such link route.");
    const tls = req.socket as TLSSocket;
    const cert = tls.getPeerCertificate?.();
    if (!tls.authorized || !cert?.fingerprint256) {
      return refuseUpgrade(socket, 401, "The link needs a client certificate that this hub signed.");
    }
    const machine = this.registry.byFingerprint(cert.fingerprint256);
    if (!machine) return refuseUpgrade(socket, 401, "This hub doesn't know the certificate.");
    if (machine.revokedAt !== null) {
      return refuseUpgrade(socket, 403, "This machine's certificate was revoked.");
    }
    wss.handleUpgrade(req, socket, head, (ws) => void this.serveLink(ws, machine));
  }

  private async serveLink(ws: WebSocket, machine: MachineRow): Promise<void> {
    let hello: LinkHello;
    try {
      const first = await awaitHello(ws, this.opts.timing?.helloMs ?? 10_000);
      if ("refused" in first) {
        ws.close(LINK_CLOSE.protocolRefused, "refused");
        return;
      }
      hello = first.hello;
    } catch {
      ws.close(LINK_CLOSE.helloTimeout, "No hello.");
      return;
    }
    const ours = this.opts.hello();
    const mismatch = protocolMismatch(ours.protocol, hello.protocol);
    if (mismatch) {
      this.opts.log(`Refused the link from ${machine.name} (${machine.id}): ${mismatch}`);
      ws.send(JSON.stringify({ type: "refuse", reason: mismatch }));
      ws.close(LINK_CLOSE.protocolRefused, "Protocol versions differ.");
      return;
    }
    // A revoke can land while the hello was on its way.
    if (this.registry.get(machine.id)?.revokedAt !== null) {
      ws.close(LINK_CLOSE.revoked, "This machine's certificate was revoked.");
      return;
    }
    ws.send(JSON.stringify(ours));
    const peer = new LinkPeer({
      socket: ws,
      machineId: machine.id,
      side: "h",
      hello,
      server: createDispatcher({
        api: this.opts.api,
        token: this.opts.token,
        caller: machine.id,
        internal: this.opts.internal,
        allow: (req: Pick<LinkRequest, "method" | "path">) =>
          this.opts.allowNodeRequest(req, machine.id),
      }),
      timeoutMs: this.opts.timing?.timeoutMs,
      pingMs: this.opts.timing?.pingMs,
      log: this.opts.log,
    });
    const old = this.peers.get(machine.id);
    this.peers.set(machine.id, peer);
    old?.close(LINK_CLOSE.replaced, "A newer link from this machine replaced this one.");
    this.registry.seen(machine.id, {
      role: hello.role,
      serverVersion: hello.serverVersion,
      protocol: hello.protocol,
      capabilities: hello.capabilities,
      platform: machinePlatform(hello.platform),
    });
    this.opts.log(`Machine ${machine.name} (${machine.id}) linked.`);
    this.opts.onChange?.();
    peer.onClose(() => {
      if (this.peers.get(machine.id) === peer) this.peers.delete(machine.id);
      this.registry.seen(machine.id);
      this.opts.log(`Machine ${machine.name} (${machine.id}) unlinked.`);
      this.opts.onChange?.();
    });
  }
}

/** A host for a URL: an IPv6 address goes in brackets. */
export function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
