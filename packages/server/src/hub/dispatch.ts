// Serves the requests and streams that arrive over a link by dispatching
// them into this machine's own API: HTTP through Fastify's `inject`, and
// WebSocket routes through `injectWebSocket`, both in-process and authenticated as
// a trusted internal caller with the server's own token. Paths under
// `/link/v1/` reach the link's own handlers instead and never the API, so a
// local API client can't call them.
import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import { ApiError, toApiError } from "../api/errors.js";
import { injectWebSocket } from "./inject.js";
import type { LinkRequest, LinkResponse, LinkStream } from "./link.js";
import { LinkError, errorResponse, type LinkServer } from "./peer.js";
import {
  LINK_CALLER_HEADER,
  LINK_INTERNAL_PREFIX,
  closeReason,
  sendableCloseCode,
} from "./protocol.js";

/** A handler for one `/link/v1/` path; `caller` is the other end's machine id. */
export type InternalHandler = (req: LinkRequest, caller: string) => Promise<LinkResponse>;

/** Headers a link request never carries into the local API. */
const DROPPED_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "connection",
  "upgrade",
  "content-length",
  "transfer-encoding",
  "origin",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-protocol",
]);

/** The headers to pass on, with the server's own token and the link's caller. */
function forwardHeaders(
  headers: Record<string, string>,
  token: string,
  caller: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!DROPPED_HEADERS.has(name.toLowerCase())) out[name.toLowerCase()] = value;
  }
  out.authorization = `Bearer ${token}`;
  out[LINK_CALLER_HEADER] = caller;
  return out;
}

/** The URL of a link request: its path and, when it has one, its query. */
export function linkUrl(req: { path: string; query?: string }): string {
  if (!req.query) return req.path;
  return `${req.path}${req.query.startsWith("?") ? "" : "?"}${req.query}`;
}

/** A JSON response. */
export function jsonResponse(status: number, body: unknown): LinkResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

/** Parses a link request's JSON body, or throws `validation`. */
export function jsonBody(req: LinkRequest): unknown {
  try {
    return JSON.parse((req.body ?? Buffer.alloc(0)).toString() || "{}");
  } catch {
    throw new ApiError("validation", "The link request body is not valid JSON.");
  }
}

/** Wraps an internal handler so a thrown error becomes its JSON error response. */
export function safely(handler: InternalHandler): InternalHandler {
  return async (req, caller) => {
    try {
      return await handler(req, caller);
    } catch (err) {
      const failure = toApiError(err);
      return jsonResponse(failure.status, failure.toBody());
    }
  };
}

/** A `LinkStream` over a client WebSocket, holding messages until a callback is registered. */
export class WsStream implements LinkStream {
  private messageCbs: ((data: Buffer, binary: boolean) => void)[] = [];
  private closeCbs: ((code: number, reason: string) => void)[] = [];
  private queued: { data: Buffer; binary: boolean }[] = [];
  private ended: { code: number; reason: string } | null = null;

  constructor(private readonly ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      const bytes = toBuffer(data);
      if (this.messageCbs.length === 0) this.queued.push({ data: bytes, binary: isBinary });
      else for (const cb of this.messageCbs) cb(bytes, isBinary);
    });
    ws.on("close", (code, reason) => this.finish(code, reason.toString()));
    ws.on("error", () => this.finish(1011, "The stream failed."));
  }

  send(data: Buffer | string, binary: boolean): void {
    if (this.ended || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(data, { binary });
  }

  /** Bytes queued on the socket but not yet sent. */
  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  /** Stops reading from the socket until `resume`. */
  pause(): void {
    this.ws.pause();
  }

  resume(): void {
    this.ws.resume();
  }

  onMessage(cb: (data: Buffer, binary: boolean) => void): void {
    this.messageCbs.push(cb);
    const queued = this.queued;
    this.queued = [];
    for (const m of queued) cb(m.data, m.binary);
  }

  close(code?: number, reason?: string): void {
    try {
      this.ws.close(sendableCloseCode(code), closeReason(reason ?? ""));
    } catch {
      this.ws.terminate();
    }
  }

  onClose(cb: (code: number, reason: string) => void): void {
    if (this.ended) cb(this.ended.code, this.ended.reason);
    else this.closeCbs.push(cb);
  }

  private finish(code: number, reason: string): void {
    if (this.ended) return;
    this.ended = { code, reason };
    const cbs = this.closeCbs;
    this.closeCbs = [];
    for (const cb of cbs) cb(code, reason);
  }
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

export interface DispatcherOptions {
  /** This machine's API; read at each call, since the API starts after the link code is built. */
  api: () => FastifyInstance | null;
  /** The server's bearer token, which the dispatched calls carry. */
  token: string;
  /** The other end's machine id, passed to internal handlers. */
  caller: string;
  /** Handlers for `/link/v1/` paths, by `METHOD /path`. */
  internal: ReadonlyMap<string, InternalHandler>;
  /** Whether the other end may call this API path; absent allows every path. */
  allow?: (req: { method: string; path: string }) => boolean;
}

/** Builds the `LinkServer` that serves one link's incoming requests and streams. */
export function createDispatcher(opts: DispatcherOptions): LinkServer {
  const refuse = (req: { method: string; path: string }) =>
    new LinkError(`This machine doesn't serve ${req.method} ${req.path} over the link.`, 403);
  return {
    async request(req) {
      if (req.path.startsWith(LINK_INTERNAL_PREFIX)) {
        const handler = opts.internal.get(`${req.method.toUpperCase()} ${req.path}`);
        if (!handler) {
          return jsonResponse(404, {
            error: { code: "not_found", message: `No link handler for ${req.method} ${req.path}.` },
          });
        }
        return handler(req, opts.caller);
      }
      if (opts.allow && !opts.allow(req)) {
        return jsonResponse(403, {
          error: { code: "unauthorized", message: refuse(req).message },
        });
      }
      const api = opts.api();
      if (!api) return errorResponse(new LinkError("This machine's API isn't ready yet."));
      const res = await api.inject({
        method: req.method.toUpperCase() as "GET",
        url: linkUrl(req),
        headers: forwardHeaders(req.headers, opts.token, opts.caller),
        ...(req.body && req.body.length > 0 ? { payload: req.body } : {}),
      });
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(res.headers)) {
        // A session cookie is a working credential for this machine's API.
        if (value === undefined || name.toLowerCase() === "set-cookie") continue;
        headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
      }
      return { status: res.statusCode, headers, body: res.rawPayload };
    },
    async openStream(req) {
      if (opts.allow && !opts.allow({ method: "GET", path: req.path })) {
        throw refuse({ method: "GET", path: req.path });
      }
      const api = opts.api();
      if (!api) throw new LinkError("This machine's API isn't ready yet.");
      let ws: WebSocket;
      try {
        ws = await injectWebSocket(
          api,
          linkUrl(req),
          forwardHeaders(req.headers, opts.token, opts.caller),
        );
      } catch (err) {
        const m = /response: (\d+)/.exec((err as Error).message);
        throw new LinkError(
          `This machine refused the stream ${req.path}: ${(err as Error).message}`,
          m ? Number(m[1]) : 502,
        );
      }
      const stream = new WsStream(ws);
      ws.resume();
      return stream;
    },
  };
}
