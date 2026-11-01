// An in-memory stand-in for the hub and node link: each `NodeLink` serves
// requests and streams by dispatching them into another in-process API
// server, authenticated with that server's own token, the way the real node
// side serves a link call as a trusted internal caller.
import WebSocket from "ws";
import type {
  LinkRegistry,
  LinkRequest,
  LinkResponse,
  LinkStream,
  NodeLink,
} from "../../src/hub/link.js";

export class FakeNodeLink implements NodeLink {
  readonly requests: LinkRequest[] = [];
  readonly streams: Omit<LinkRequest, "body" | "method">[] = [];
  private readonly closeListeners: (() => void)[] = [];
  /** When set, `request` and `openStream` wait this long before they start. */
  delayMs = 0;
  /** When set, `request` and `openStream` reject with it. */
  fail: Error | null = null;

  constructor(
    readonly machineId: string,
    private readonly base: string,
    private readonly token: string,
  ) {}

  private url(req: { path: string; query?: string }, scheme: "http" | "ws"): string {
    const origin = this.base.replace(/^http/, scheme);
    return `${origin}${req.path}${req.query === undefined ? "" : `?${req.query}`}`;
  }

  private async gate(): Promise<void> {
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw this.fail;
  }

  async request(req: LinkRequest): Promise<LinkResponse> {
    this.requests.push(req);
    await this.gate();
    const res = await fetch(this.url(req, "http"), {
      method: req.method,
      headers: { ...req.headers, authorization: `Bearer ${this.token}` },
      body: req.body,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, name) => (headers[name] = value));
    return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) };
  }

  async openStream(req: Omit<LinkRequest, "body" | "method">): Promise<LinkStream> {
    this.streams.push(req);
    await this.gate();
    const ws = new WebSocket(this.url(req, "ws"), {
      headers: { ...req.headers, authorization: `Bearer ${this.token}` },
    });
    // Frames that arrive before the caller registers its listener wait here.
    const early: [Buffer, boolean][] = [];
    let onMessage: ((data: Buffer, binary: boolean) => void) | null = null;
    ws.on("message", (data, binary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (onMessage) onMessage(buf, binary);
      else early.push([buf, binary]);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("unexpected-response", (r, res) => {
        r.destroy();
        reject(new Error(`The upgrade failed with HTTP ${res.statusCode}.`));
      });
    });
    return {
      send: (data, binary) => {
        if (ws.readyState === ws.OPEN) ws.send(data, { binary });
      },
      onMessage: (cb) => {
        onMessage = cb;
        for (const [data, binary] of early.splice(0)) cb(data, binary);
      },
      close: (code, reason) => ws.close(code, reason),
      onClose: (cb) => ws.on("close", (code, reason) => cb(code, reason.toString())),
    };
  }

  onClose(cb: () => void): void {
    this.closeListeners.push(cb);
  }
}

export class FakeRegistry implements LinkRegistry {
  readonly links = new Map<string, NodeLink>();
  get(machineId: string): NodeLink | undefined {
    return this.links.get(machineId);
  }
  list(): string[] {
    return [...this.links.keys()];
  }
}
