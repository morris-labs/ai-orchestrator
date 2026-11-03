// The node side of multi-host: joining a hub with an enrollment code, and
// keeping one WebSocket open to it over mutual TLS. The node dials out, so
// it needs no open port, and reconnects with exponential backoff whenever
// the link drops.
import { X509Certificate, createPrivateKey, randomBytes } from "node:crypto";
import http from "node:http";
import tls from "node:tls";
import { HUB_MACHINE_ID, type NodeLinkState } from "@aio/contracts";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../api/errors.js";
import { newNodeKey, readNodeLinkFiles, writeNodeLinkFiles, type NodeLinkFiles } from "./ca.js";
import { createDispatcher, type InternalHandler } from "./dispatch.js";
import { EnrollResponseSchema, MAX_LINK_FRAME, awaitHello, type LinkTiming } from "./hub.js";
import { LinkPeer } from "./peer.js";
import { LINK_CLOSE, LINK_PATHS, protocolMismatch, type LinkHello } from "./protocol.js";
import { codeKey, hubProof, nodeProof, sameHex } from "./registry.js";

/**
 * The status of a refused enrollment. Not 401: the caller's token for this
 * server is fine, and clients read a 401 as a bad token.
 */
const ENROLLMENT_REFUSED_STATUS = 403;

/** The id a plain node's registry gives its hub. */
export const HUB_LINK_ID = HUB_MACHINE_ID;

export interface NodeAgentOptions {
  /** `DATA_DIR/link`, where the client certificate and the hub's pin live. */
  dir: string;
  /** Whether this machine may link to a hub now: its role isn't `hub`. */
  mayLink: () => boolean;
  /** The hello this node sends; `name` is replaced by the enrolled name. */
  hello: () => LinkHello;
  token: string;
  api: () => FastifyInstance | null;
  /** The link handlers the hub may call, by `METHOD /path`. */
  internal: ReadonlyMap<string, InternalHandler>;
  timing?: LinkTiming & {
    /** The first reconnect delay in milliseconds. Default 1 second. */
    backoffMinMs?: number;
    /** The longest reconnect delay in milliseconds. Default 60 seconds. */
    backoffMaxMs?: number;
  };
  log: (message: string) => void;
  /** Called when the link to the hub comes up or goes down. */
  onChange?: () => void;
}

/** The pinned TLS options for the hub's link certificate. */
function pinnedHubTls(files: NodeLinkFiles) {
  return {
    ca: files.hubCa,
    cert: files.clientCert,
    key: files.clientKey,
    rejectUnauthorized: true as const,
    checkServerIdentity: (_host: string, cert: tls.PeerCertificate) =>
      cert.fingerprint256 === files.config.hubFingerprint
        ? undefined
        : new Error(
            "The hub presented a certificate other than the one this machine pinned when it joined. Join the hub again if its certificate changed.",
          ),
  };
}

/** The `wss:` URL of the hub's link route. */
function connectUrl(hubUrl: string): string {
  const url = new URL(LINK_PATHS.connect, hubUrl);
  url.protocol = "wss:";
  return url.toString();
}

export class NodeAgent {
  private files: NodeLinkFiles | null = null;
  private peer: LinkPeer | null = null;
  private socket: WebSocket | null = null;
  private state: NodeLinkState = "none";
  private error: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private backoff = 0;
  private stopped = false;
  /** Bumped on every (re)start, so a stale socket's events change nothing. */
  private generation = 0;
  /** True while a join runs, so that a second one can't race on the link files. */
  private joining = false;

  constructor(private readonly opts: NodeAgentOptions) {}

  /** Reads the link files and connects when this machine has joined a hub. */
  async start(): Promise<void> {
    this.files = await readNodeLinkFiles(this.opts.dir, this.opts.log);
    if (this.files && this.opts.mayLink()) this.connect();
  }

  /** The link to the hub, while it's up. */
  get link(): LinkPeer | undefined {
    return this.peer?.isOpen ? this.peer : undefined;
  }

  get joined(): NodeLinkFiles["config"] | null {
    return this.files?.config ?? null;
  }

  status(): { link: NodeLinkState; error: string | null } {
    return { link: this.files ? this.state : "none", error: this.error };
  }

  /**
   * Joins the hub at `hubUrl` with a one-time `code`: creates this machine's
   * key, proves the code over the certificate the hub presents, pins that
   * certificate, stores the client certificate the hub signs, and connects.
   *
   * A machine that has joined a hub keeps that enrollment: the join fails with
   * `conflict` before it spends the code, unless the hub revoked this machine
   * or the caller sets `replaceHub`.
   */
  async join(input: {
    hubUrl: string;
    code: string;
    name: string;
    replaceHub?: boolean;
  }): Promise<void> {
    if (this.joining) {
      throw new ApiError("conflict", "This machine is joining a hub. Wait for that join to end.");
    }
    const joined = this.joined;
    if (joined && this.state !== "revoked" && !input.replaceHub) {
      throw new ApiError(
        "conflict",
        `This machine already joined the hub at ${joined.hubUrl} as ${joined.name}, and the code is still unused. To move this machine, revoke ${joined.machineId} on that hub first, or run aio node join with --replace-hub.`,
      );
    }
    this.joining = true;
    try {
      await this.enroll(input);
    } finally {
      this.joining = false;
    }
  }

  private async enroll(input: { hubUrl: string; code: string; name: string }): Promise<void> {
    let url: URL;
    try {
      url = new URL(input.hubUrl);
    } catch {
      throw new ApiError("validation", `${input.hubUrl} isn't a URL.`);
    }
    if (url.protocol !== "https:") {
      throw new ApiError("validation", "The hub URL must start with https://.");
    }
    const port = Number(url.port || 443);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const key = codeKey(input.code);
    const nodeKey = newNodeKey();
    const nonce = randomBytes(32).toString("hex");

    // Trust on first use: the proof below binds the code to the certificate
    // seen on this very connection.
    const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const s = tls.connect({
        host,
        port,
        servername: net_isIp(host) ? undefined : host,
        rejectUnauthorized: false,
      });
      s.setTimeout(15_000, () => s.destroy(new Error("The hub didn't answer in time.")));
      s.once("secureConnect", () => resolve(s));
      s.once("error", reject);
    }).catch((err: Error) => {
      throw new ApiError(
        "hub_unreachable",
        `Can't reach the hub at ${input.hubUrl}: ${err.message}`,
      );
    });
    const seen = socket.getPeerCertificate();
    if (!seen?.fingerprint256) {
      socket.destroy();
      throw new ApiError("hub_unreachable", "The hub presented no certificate.");
    }
    const body = JSON.stringify({
      name: input.name,
      publicKey: nodeKey.publicKey,
      nonce,
      proof: nodeProof(key, {
        hubFingerprint: seen.fingerprint256,
        nonce,
        name: input.name,
        publicKey: nodeKey.publicKey,
      }),
    });
    const { status, text } = await new Promise<{ status: number; text: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            method: "POST",
            path: LINK_PATHS.enroll,
            headers: {
              host: url.host,
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
            // No agent: the request goes over the socket whose certificate the proof covers.
            createConnection: () => socket,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () =>
              resolve({ status: res.statusCode ?? 502, text: Buffer.concat(chunks).toString() }),
            );
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end(body);
      },
    ).catch((err: Error) => {
      throw new ApiError("hub_unreachable", `The enrollment request failed: ${err.message}`);
    });
    socket.destroy();

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(
        "hub_unreachable",
        `The hub answered ${status} with a body that isn't JSON.`,
      );
    }
    if (status !== 200) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      const reason = err?.message ?? `status ${status}`;
      if (err?.code === "conflict" || err?.code === "validation") {
        throw new ApiError(err.code, `The hub refused the enrollment: ${reason}`);
      }
      if (err?.code === "unauthorized") {
        throw new ApiError(
          "unauthorized",
          `The hub refused the enrollment: ${reason}`,
          undefined,
          ENROLLMENT_REFUSED_STATUS,
        );
      }
      // Any other answer says nothing about the code, such as a failure on the hub.
      throw new ApiError("hub_unreachable", `The hub couldn't process the enrollment: ${reason}`);
    }
    const parsed = EnrollResponseSchema.safeParse(json);
    if (!parsed.success)
      throw new ApiError(
        "hub_unreachable",
        "The hub's enrollment answer doesn't match its schema.",
      );
    const res = parsed.data;
    const expected = hubProof(key, {
      nonce,
      machineId: res.machineId,
      clientCert: res.clientCert,
      hubCert: res.hubCert,
    });
    if (!sameHex(expected, res.proof)) {
      throw new ApiError(
        "unauthorized",
        "The hub couldn't prove it issued this code, so this machine didn't trust it. Check the hub URL.",
        undefined,
        ENROLLMENT_REFUSED_STATUS,
      );
    }
    try {
      const hubCert = new X509Certificate(res.hubCert);
      const caCert = new X509Certificate(res.caCert);
      const clientCert = new X509Certificate(res.clientCert);
      if (hubCert.fingerprint256 !== seen.fingerprint256) throw new Error("pin");
      if (!hubCert.verify(caCert.publicKey) || !clientCert.verify(caCert.publicKey)) {
        throw new Error("chain");
      }
      if (!clientCert.checkPrivateKey(createPrivateKey(nodeKey.key))) throw new Error("key");
    } catch {
      throw new ApiError(
        "unauthorized",
        "The certificates the hub returned don't match the connection or this machine's key.",
        undefined,
        ENROLLMENT_REFUSED_STATUS,
      );
    }
    const files: NodeLinkFiles = {
      config: {
        hubUrl: `https://${url.host}`,
        machineId: res.machineId,
        name: res.name,
        hubFingerprint: seen.fingerprint256,
        joinedAt: new Date().toISOString(),
      },
      clientKey: nodeKey.key,
      clientCert: res.clientCert,
      hubCa: res.caCert,
      hubCert: res.hubCert,
    };
    await writeNodeLinkFiles(this.opts.dir, files);
    this.files = files;
    this.opts.log(`Joined the hub at ${files.config.hubUrl} as ${res.name} (${res.machineId}).`);
    this.restart();
  }

  /** Drops the link and connects again with the current files, when allowed. */
  restart(): void {
    this.dropSocket();
    this.backoff = 0;
    this.error = null;
    if (this.files && this.opts.mayLink() && !this.stopped) this.connect();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.dropSocket();
  }

  private dropSocket(): void {
    this.generation += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const peer = this.peer;
    this.peer = null;
    peer?.close(1000, "The node is reconnecting or stopping.");
    this.socket?.terminate();
    this.socket = null;
  }

  private setState(state: NodeLinkState, error: string | null): void {
    const changed = state !== this.state;
    this.state = state;
    this.error = error;
    if (changed) this.opts.onChange?.();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const min = this.opts.timing?.backoffMinMs ?? 1000;
    const max = this.opts.timing?.backoffMaxMs ?? 60_000;
    const base = Math.min(max, min * 2 ** this.backoff);
    this.backoff += 1;
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    const gen = this.generation;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (gen === this.generation && !this.stopped) this.connect();
    }, delay);
    this.retryTimer.unref();
  }

  private connect(): void {
    const files = this.files;
    if (!files || this.stopped) return;
    const gen = ++this.generation;
    const current = () => gen === this.generation;
    this.setState("connecting", this.error);
    const ws = new WebSocket(connectUrl(files.config.hubUrl), {
      ...pinnedHubTls(files),
      maxPayload: MAX_LINK_FRAME,
      handshakeTimeout: 15_000,
    } as unknown as WebSocket.ClientOptions);
    this.socket = ws;
    let terminal: { state: NodeLinkState; error: string } | null = null;

    ws.on("unexpected-response", (_req, res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const message =
          Buffer.concat(chunks).toString().slice(0, 300) || `status ${res.statusCode}`;
        if (current()) {
          if (res.statusCode === 403) {
            terminal = { state: "revoked", error: `The hub revoked this machine: ${message}` };
            this.setState("revoked", terminal.error);
            this.opts.log(terminal.error);
          } else if (res.statusCode === 401) {
            this.setState(
              "refused",
              `The hub doesn't accept this machine's certificate: ${message} Join the hub again.`,
            );
          } else {
            this.setState("disconnected", `The hub answered the link with ${message}.`);
          }
        }
        // The close handler schedules the retry, unless the machine is revoked.
        ws.terminate();
      });
    });

    ws.on("error", (err) => {
      if (!current() || terminal) return;
      this.error = `Can't reach the hub at ${files.config.hubUrl}: ${err.message}`;
    });

    ws.on("open", () => {
      if (!current()) return;
      const ours = { ...this.opts.hello(), name: files.config.name };
      ws.send(JSON.stringify(ours));
      awaitHello(ws, this.opts.timing?.helloMs ?? 10_000).then(
        (first) => {
          if (!current()) return;
          if ("refused" in first) {
            terminal = { state: "refused", error: `The hub refused the link: ${first.refused}` };
            this.setState("refused", terminal.error);
            this.opts.log(terminal.error);
            return;
          }
          const mismatch = protocolMismatch(ours.protocol, first.hello.protocol);
          if (mismatch) {
            terminal = {
              state: "refused",
              error: `This machine refused the hub's link: ${mismatch}`,
            };
            ws.send(JSON.stringify({ type: "refuse", reason: mismatch }));
            ws.close(LINK_CLOSE.protocolRefused, "Protocol versions differ.");
            this.setState("refused", terminal.error);
            this.opts.log(terminal.error);
            return;
          }
          const peer = new LinkPeer({
            socket: ws,
            machineId: HUB_LINK_ID,
            side: "n",
            hello: first.hello,
            server: createDispatcher({
              api: this.opts.api,
              token: this.opts.token,
              caller: HUB_LINK_ID,
              internal: this.opts.internal,
            }),
            timeoutMs: this.opts.timing?.timeoutMs,
            pingMs: this.opts.timing?.pingMs,
            log: this.opts.log,
          });
          this.peer = peer;
          this.backoff = 0;
          this.setState("connected", null);
          this.opts.log(`Linked to the hub at ${files.config.hubUrl}.`);
        },
        (err: Error) => {
          if (!current()) return;
          this.error = err.message;
          ws.terminate();
        },
      );
    });

    ws.on("close", (code, reason) => {
      if (!current()) return;
      const wasUp = this.peer !== null;
      this.peer = null;
      this.socket = null;
      if (code === LINK_CLOSE.revoked) {
        this.setState("revoked", `The hub revoked this machine: ${reason.toString()}`);
        this.opts.log("The hub revoked this machine; the link stays down.");
        return;
      }
      if (terminal?.state === "revoked") return;
      if (terminal?.state === "refused") {
        // The hub might be updated; try again at the slowest pace.
        this.backoff = 64;
        this.scheduleRetry();
        return;
      }
      if (this.state !== "refused" && this.state !== "disconnected") {
        this.setState(
          "disconnected",
          this.error ?? (wasUp ? "The link to the hub dropped." : null),
        );
      }
      if (wasUp) this.opts.log("The link to the hub dropped; reconnecting.");
      this.scheduleRetry();
    });
  }
}

function net_isIp(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(":");
}
