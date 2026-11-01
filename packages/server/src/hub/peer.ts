// One end of a hub-node link: a `NodeLink` over a WebSocket whose hello is
// already exchanged. It sends requests and opens streams to the other end,
// and serves the other end's requests and streams through a `LinkServer`,
// which dispatches them into this machine's own API.
import type WebSocket from "ws";
import type { LinkRequest, LinkResponse, LinkStream, NodeLink } from "./link.js";
import {
  closeReason,
  parseFrame,
  sendableCloseCode,
  type LinkFrame,
  type LinkHello,
} from "./protocol.js";

/** What serves the requests and streams that arrive over a link. */
export interface LinkServer {
  request(req: LinkRequest): Promise<LinkResponse>;
  openStream(req: Omit<LinkRequest, "body" | "method">): Promise<LinkStream>;
}

/** The error a request or stream open gets when the link is down or the other end refused. */
export class LinkError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

export interface LinkPeerOptions {
  socket: WebSocket;
  /** The other end's machine id: a node's id on the hub, `hub` on a node. */
  machineId: string;
  /** This end's id prefix: `h` on the hub, `n` on a node. */
  side: "h" | "n";
  /** The other end's hello. */
  hello: LinkHello;
  server: LinkServer;
  /** Milliseconds a request or stream open waits for its answer. Default 60 seconds. */
  timeoutMs?: number;
  /** Milliseconds between pings; a ping without a pong by the next one ends the link. Default 15 seconds. */
  pingMs?: number;
  log?: (message: string) => void;
}

interface Pending {
  resolve(value: LinkFrame): void;
  reject(err: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * A stream whose bytes travel over the link. Messages and the close that
 * arrive before a callback is registered wait for it, so nothing the other
 * end sends right after the open is lost.
 */
class PeerStream implements LinkStream {
  private messageCbs: ((data: Buffer, binary: boolean) => void)[] = [];
  private closeCbs: ((code: number, reason: string) => void)[] = [];
  private queued: { data: Buffer; binary: boolean }[] = [];
  private ended: { code: number; reason: string } | null = null;

  constructor(
    private readonly peer: LinkPeer,
    readonly id: string,
  ) {}

  send(data: Buffer | string, binary: boolean): void {
    if (this.ended) return;
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    this.peer.sendFrame({ type: "data", id: this.id, binary, data: bytes.toString("base64") });
  }

  onMessage(cb: (data: Buffer, binary: boolean) => void): void {
    this.messageCbs.push(cb);
    const queued = this.queued;
    this.queued = [];
    for (const m of queued) cb(m.data, m.binary);
  }

  close(code?: number, reason?: string): void {
    if (this.ended) return;
    const c = sendableCloseCode(code);
    const r = closeReason(reason ?? "");
    this.peer.sendFrame({ type: "end", id: this.id, code: c, reason: r });
    this.finish(c, r);
  }

  onClose(cb: (code: number, reason: string) => void): void {
    if (this.ended) cb(this.ended.code, this.ended.reason);
    else this.closeCbs.push(cb);
  }

  /** Delivers a message from the other end. */
  deliver(data: Buffer, binary: boolean): void {
    if (this.ended) return;
    if (this.messageCbs.length === 0) this.queued.push({ data, binary });
    else for (const cb of this.messageCbs) cb(data, binary);
  }

  /** Ends the stream without telling the other end, which ended it or is gone. */
  finish(code: number, reason: string): void {
    if (this.ended) return;
    this.ended = { code, reason };
    this.peer.forgetStream(this.id);
    const cbs = this.closeCbs;
    this.closeCbs = [];
    for (const cb of cbs) cb(code, reason);
  }
}

export class LinkPeer implements NodeLink {
  readonly machineId: string;
  readonly hello: LinkHello;
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  /** Streams this end opened, by id. */
  private readonly outgoing = new Map<string, PeerStream>();
  /** Streams the other end opened, served by a local stream, by id. */
  private readonly incoming = new Map<string, LinkStream>();
  private closeCbs: (() => void)[] = [];
  private closed = false;
  private pingTimer: NodeJS.Timeout | null = null;
  private awaitingPong = false;

  constructor(private readonly opts: LinkPeerOptions) {
    this.machineId = opts.machineId;
    this.hello = opts.hello;
    const socket = opts.socket;
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const frame = parseFrame(rawText(data));
      if (frame) this.receive(frame);
    });
    socket.on("close", () => this.shutdown());
    socket.on("error", () => this.shutdown());
    socket.on("pong", () => {
      this.awaitingPong = false;
    });
    this.pingTimer = setInterval(() => {
      if (this.awaitingPong) {
        opts.log?.(`The link to ${this.machineId} stopped answering pings; closing it.`);
        socket.terminate();
        return;
      }
      this.awaitingPong = true;
      try {
        socket.ping();
      } catch {
        // The close handler cleans up.
      }
    }, opts.pingMs ?? 15_000);
    this.pingTimer.unref();
  }

  /** True until the socket closes. */
  get isOpen(): boolean {
    return !this.closed;
  }

  /** True when the other end's hello lists `capability`. */
  can(capability: string): boolean {
    return this.hello.capabilities.includes(capability);
  }

  request(req: LinkRequest): Promise<LinkResponse> {
    const id = this.newId();
    const answer = this.await(id, `${req.method} ${req.path}`);
    this.sendFrame({
      type: "req",
      id,
      method: req.method,
      path: req.path,
      ...(req.query ? { query: req.query } : {}),
      headers: req.headers,
      ...(req.body && req.body.length > 0 ? { body: req.body.toString("base64") } : {}),
    });
    return answer.then((frame) => {
      if (frame.type !== "res") throw new LinkError("The link answered with the wrong frame.");
      return {
        status: frame.status,
        headers: frame.headers,
        body: Buffer.from(frame.body, "base64"),
      };
    });
  }

  async openStream(req: Omit<LinkRequest, "body" | "method">): Promise<LinkStream> {
    const id = this.newId();
    const stream = new PeerStream(this, id);
    this.outgoing.set(id, stream);
    const answer = this.await(id, `the stream ${req.path}`);
    this.sendFrame({
      type: "open",
      id,
      path: req.path,
      ...(req.query ? { query: req.query } : {}),
      headers: req.headers,
    });
    try {
      const frame = await answer;
      if (frame.type === "openFailed") throw new LinkError(frame.message, frame.status);
      return stream;
    } catch (err) {
      this.outgoing.delete(id);
      throw err;
    }
  }

  onClose(cb: () => void): void {
    if (this.closed) cb();
    else this.closeCbs.push(cb);
  }

  /** Closes the link with a WebSocket close code and reason. */
  close(code = 1000, reason = ""): void {
    try {
      this.opts.socket.close(sendableCloseCode(code), closeReason(reason));
    } catch {
      this.opts.socket.terminate();
    }
    this.shutdown();
  }

  /** Sends one frame; a closed link drops it. */
  sendFrame(frame: LinkFrame): void {
    if (this.closed || this.opts.socket.readyState !== this.opts.socket.OPEN) return;
    this.opts.socket.send(JSON.stringify(frame));
  }

  forgetStream(id: string): void {
    this.outgoing.delete(id);
  }

  private newId(): string {
    return `${this.opts.side}${this.nextId++}`;
  }

  private await(id: string, what: string): Promise<LinkFrame> {
    if (this.closed) return Promise.reject(new LinkError(`The link to ${this.machineId} is closed.`));
    return new Promise<LinkFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LinkError(`${this.machineId} didn't answer ${what} in time.`, 504));
      }, this.opts.timeoutMs ?? 60_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private settle(id: string, frame: LinkFrame): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(frame);
  }

  private receive(frame: LinkFrame): void {
    switch (frame.type) {
      case "res":
      case "opened":
      case "openFailed":
        this.settle(frame.id, frame);
        return;
      case "req":
        void this.serveRequest(frame);
        return;
      case "open":
        void this.serveStream(frame);
        return;
      case "data": {
        const bytes = Buffer.from(frame.data, "base64");
        const out = this.outgoing.get(frame.id);
        if (out) out.deliver(bytes, frame.binary);
        else this.incoming.get(frame.id)?.send(bytes, frame.binary);
        return;
      }
      case "end": {
        const out = this.outgoing.get(frame.id);
        if (out) {
          out.finish(frame.code, frame.reason);
          return;
        }
        const local = this.incoming.get(frame.id);
        if (local) {
          this.incoming.delete(frame.id);
          local.close(frame.code, frame.reason);
        }
        return;
      }
      default:
        // A hello or refuse after the handshake means nothing; ignore it.
        return;
    }
  }

  private async serveRequest(frame: Extract<LinkFrame, { type: "req" }>): Promise<void> {
    let res: LinkResponse;
    try {
      res = await this.opts.server.request({
        method: frame.method,
        path: frame.path,
        query: frame.query,
        headers: frame.headers,
        body: frame.body === undefined ? undefined : Buffer.from(frame.body, "base64"),
      });
    } catch (err) {
      res = errorResponse(err);
    }
    this.sendFrame({
      type: "res",
      id: frame.id,
      status: res.status,
      headers: res.headers,
      body: res.body.toString("base64"),
    });
  }

  private async serveStream(frame: Extract<LinkFrame, { type: "open" }>): Promise<void> {
    let local: LinkStream;
    try {
      local = await this.opts.server.openStream({
        path: frame.path,
        query: frame.query,
        headers: frame.headers,
      });
    } catch (err) {
      const status = (err as { status?: number }).status ?? 502;
      this.sendFrame({
        type: "openFailed",
        id: frame.id,
        status,
        message: (err as Error).message ?? String(err),
      });
      return;
    }
    if (this.closed) {
      local.close(1001, "The link closed.");
      return;
    }
    this.incoming.set(frame.id, local);
    this.sendFrame({ type: "opened", id: frame.id });
    local.onMessage((data, binary) => {
      this.sendFrame({ type: "data", id: frame.id, binary, data: data.toString("base64") });
    });
    local.onClose((code, reason) => {
      if (this.incoming.get(frame.id) !== local) return;
      this.incoming.delete(frame.id);
      this.sendFrame({
        type: "end",
        id: frame.id,
        code: sendableCloseCode(code),
        reason: closeReason(reason),
      });
    });
  }

  private shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    const err = new LinkError(`The link to ${this.machineId} closed.`);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(err);
    }
    for (const stream of [...this.outgoing.values()]) stream.finish(1001, "The link closed.");
    for (const [id, local] of this.incoming) {
      this.incoming.delete(id);
      local.close(1001, "The link closed.");
    }
    const cbs = this.closeCbs;
    this.closeCbs = [];
    for (const cb of cbs) {
      try {
        cb();
      } catch (e) {
        this.opts.log?.(`A link close handler failed: ${(e as Error).message}`);
      }
    }
  }
}

/** The text of a `ws` message. */
export function rawText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return Buffer.from(data as ArrayBuffer).toString();
}

/** A JSON error response for a request the server couldn't serve. */
export function errorResponse(err: unknown): LinkResponse {
  const status = (err as { status?: number }).status ?? 502;
  const code = (err as { code?: unknown }).code;
  const body = {
    error: {
      code: typeof code === "string" ? code : status === 503 ? "hub_unreachable" : "internal",
      message: (err as Error).message ?? String(err),
    },
  };
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: Buffer.from(JSON.stringify(body)),
  };
}
