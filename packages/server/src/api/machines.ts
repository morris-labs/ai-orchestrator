// The machine proxy route, `/api/v1/machines/:machineId/proxy/*`: sends any
// server API call, HTTP or WebSocket, to the machine it names.
//
// - `local`, this server's own machine ID, and `hub` on a hub that hasn't
//   joined another hub never reach the route:
//   `localMachineRewrite` turns the URL back into `/api/v1/<rest>` before
//   routing, so the call meets the real route, its schemas and its auth.
// - On a hub (role `hub` or `both`), the call goes over the named node's
//   link as `/api/v1/<rest>`, with the query kept, the hop-by-hop and auth
//   headers removed, and `x-aio-forwarded-by` added. The link is the trust
//   boundary: the node serves the call as a trusted internal caller.
// - On a plain node (role `node`), the call goes to the hub's link
//   unchanged, and the hub routes it on.
import {
  API_PREFIX,
  FORWARDED_BY_HEADER,
  HUB_MACHINE_ID,
  LOCAL_MACHINE_ID,
  MACHINE_PROXY_PATH,
} from "@aio/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type WebSocket from "ws";
import type { LinkRegistry, LinkRequest, LinkStream, NodeLink } from "../hub/link.js";
import { ApiError, isApiErrorCode } from "./errors.js";

/** What this server is in a fleet. */
export type ServerRole = "hub" | "node" | "both";

/** How the machine proxy route resolves and forwards calls. */
export interface MachineRoutingOptions {
  /** The server's role. Default: `both`, a single-PC install. */
  role?: ServerRole;
  /** This server's own enrolled machine ID, which resolves like `local`. */
  machineId?: string;
  /**
   * True when `machineId` names an enrolled machine. It tells an offline
   * machine (503) from an unknown one (404); without it, a machine with no
   * link is unknown.
   */
  isKnown?(machineId: string): boolean;
  /** Timeouts in milliseconds for forwarded calls. */
  timeouts?: {
    /** `GET` and `HEAD` calls. Default: 28 seconds, under the clients' 30. */
    readMs?: number;
    /** Every other method. Default: 9.5 minutes, under the clients' 10. */
    writeMs?: number;
    /** Opening a relayed WebSocket. Default: 15 seconds. */
    openMs?: number;
  };
}

export const DEFAULT_READ_TIMEOUT_MS = 28_000;
export const DEFAULT_WRITE_TIMEOUT_MS = 570_000;
export const DEFAULT_OPEN_TIMEOUT_MS = 15_000;

/**
 * Bytes a relayed socket can hold unsent before the relay closes it. With
 * `flow.v1`, the relay holds the node back long before this, so the limit
 * applies to a link without flow control, where a client that stops reading
 * would otherwise make the server buffer without limit.
 */
export const RELAY_MAX_BUFFERED = 8 * 1024 * 1024;

/** How many servers can forward one call before the next refuses it as a loop. */
export const MAX_FORWARD_HOPS = 4;

/** Headers that describe one connection and never cross a link. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/** Request headers that carry this server's credentials or origin. */
const REQUEST_ONLY = new Set(["authorization", "cookie", "origin"]);

/** WebSocket handshake headers: the link runs its own handshake. */
const HANDSHAKE = new Set([
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
]);

const PROXY_URL = /^\/api\/v1\/machines\/([^/?#]+)\/proxy(\/[^?#]*)?(?:\?([^#]*))?/;

interface ProxyTarget {
  machineId: string;
  /** The path after the proxy prefix, without a leading slash. */
  rest: string;
  query: string | undefined;
}

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Splits a machine proxy URL, or returns null for any other URL. */
export function parseProxyUrl(url: string): ProxyTarget | null {
  const m = PROXY_URL.exec(url);
  if (!m) return null;
  const rest = (m[2] ?? "/").slice(1);
  const query = m[3] === undefined || m[3] === "" ? undefined : m[3];
  return { machineId: decodeId(m[1] as string), rest, query };
}

/**
 * True when `machineId` names this server: `local`, the ID its hub gave it,
 * or `hub` on a hub (role `hub` or `both`) that hasn't joined another hub.
 * A hub's own machine list calls it `local`, so it has no enrolled ID; the
 * `hub` case serves a node's call to `/api/v1/machines/hub/proxy/...`,
 * which arrives over the link unchanged.
 */
export function isThisMachine(
  machineId: string,
  options: MachineRoutingOptions | undefined,
): boolean {
  if (machineId === LOCAL_MACHINE_ID) return true;
  if (options?.machineId !== undefined) return machineId === options.machineId;
  return machineId === HUB_MACHINE_ID && (options?.role ?? "both") !== "node";
}

/**
 * Fastify's `rewriteUrl`: turns a machine proxy URL that names this server
 * into the plain route URL, and leaves every other URL as it is.
 */
export function localMachineRewrite(options: MachineRoutingOptions | undefined) {
  return (url: string): string => {
    const target = parseProxyUrl(url);
    if (!target) return url;
    if (!isThisMachine(target.machineId, options)) return url;
    return `${API_PREFIX}/${target.rest}${target.query === undefined ? "" : `?${target.query}`}`;
  };
}

/** Copies the headers that may cross a link, as a plain lowercase map. */
export function forwardableHeaders(
  raw: Record<string, string | string[] | undefined>,
  kind: "request" | "response" | "stream",
): Record<string, string> {
  const named = new Set<string>();
  const connection = raw.connection;
  for (const value of Array.isArray(connection) ? connection : [connection ?? ""]) {
    for (const name of value.split(",")) if (name.trim()) named.add(name.trim().toLowerCase());
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = key.toLowerCase();
    if (value === undefined || HOP_BY_HOP.has(name) || named.has(name)) continue;
    if (kind !== "response" && REQUEST_ONLY.has(name)) continue;
    if (kind === "response" && name === "set-cookie") continue;
    if (kind === "stream" && HANDSHAKE.has(name)) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

interface Resolved {
  link: NodeLink;
  /** The path to send over the link. */
  path: string;
}

/** Finds the link for a call to `machineId`, or throws the API error to answer. */
export function resolveMachine(
  links: LinkRegistry | undefined,
  options: MachineRoutingOptions | undefined,
  target: ProxyTarget,
  originalPath: string,
): Resolved {
  const id = target.machineId;
  const role = options?.role ?? "both";
  if (!links) {
    throw new ApiError(
      "not_found",
      `No machine has the ID ${id}. This server isn't linked to other machines, so only "${LOCAL_MACHINE_ID}" resolves.`,
    );
  }
  if (role === "node") {
    const hub = links.get("hub");
    if (!hub) {
      throw new ApiError(
        "machine_offline",
        `The hub isn't connected, so machine ${id} can't be reached. Try again once the link to the hub is back.`,
      );
    }
    return { link: hub, path: originalPath };
  }
  const link = links.get(id);
  if (!link) {
    if (options?.isKnown?.(id)) {
      throw new ApiError("machine_offline", `Machine ${id} is offline: it has no link to the hub.`);
    }
    throw new ApiError("not_found", `No machine has the ID ${id}.`);
  }
  return { link, path: `${API_PREFIX}/${target.rest}` };
}

/** The `x-aio-forwarded-by` value after this server adds itself. */
function forwardedBy(previous: string | undefined, options: MachineRoutingOptions | undefined) {
  const self = options?.machineId ?? options?.role ?? "both";
  const hops = (previous ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hops.length >= MAX_FORWARD_HOPS) {
    throw new ApiError(
      "conflict",
      `The call was forwarded ${hops.length} times (${hops.join(", ")}); check the server roles for a routing loop.`,
      undefined,
      508,
    );
  }
  return [...hops, self].join(", ");
}

/** Rejects with `machine_timeout` when `promise` takes longer than `ms`. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onLate?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new ApiError("machine_timeout", message));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        if (timedOut) onLate?.(value);
        else resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (!timedOut) reject(err);
      },
    );
  });
}

/** The API error for a failed link call: a contract error keeps its code. */
function linkFailure(err: unknown, machineId: string): ApiError {
  if (err instanceof ApiError) return err;
  const { code, status } = err as { code?: unknown; status?: unknown };
  const message = err instanceof Error ? err.message : String(err);
  if (isApiErrorCode(code)) {
    return new ApiError(code, message, undefined, typeof status === "number" ? status : undefined);
  }
  return new ApiError("machine_offline", `The link to machine ${machineId} failed: ${message}`);
}

interface Deps {
  links?: LinkRegistry;
  machines?: MachineRoutingOptions;
}

function targetOf(request: FastifyRequest): { target: ProxyTarget; path: string } {
  const url = request.raw.url ?? request.url;
  const target = parseProxyUrl(url);
  if (!target) throw new ApiError("not_found", `No route for ${request.method} ${url}.`);
  return { target, path: url.split("?")[0] as string };
}

async function forwardHttp(deps: Deps, request: FastifyRequest, reply: FastifyReply) {
  const { target, path } = targetOf(request);
  const resolved = resolveMachine(deps.links, deps.machines, target, path);
  const headers = forwardableHeaders(request.headers, "request");
  headers[FORWARDED_BY_HEADER] = forwardedBy(headers[FORWARDED_BY_HEADER], deps.machines);
  const body = Buffer.isBuffer(request.body) && request.body.length > 0 ? request.body : undefined;
  const req: LinkRequest = { method: request.method, path: resolved.path, headers };
  if (target.query !== undefined) req.query = target.query;
  if (body) req.body = body;
  const read = request.method === "GET" || request.method === "HEAD";
  const ms = read
    ? (deps.machines?.timeouts?.readMs ?? DEFAULT_READ_TIMEOUT_MS)
    : (deps.machines?.timeouts?.writeMs ?? DEFAULT_WRITE_TIMEOUT_MS);
  let res;
  try {
    res = await withTimeout(
      resolved.link.request(req),
      ms,
      `Machine ${target.machineId} didn't answer ${request.method} /${target.rest} within ${Math.round(ms / 1000)} seconds.`,
    );
  } catch (err) {
    throw linkFailure(err, target.machineId);
  }
  reply.code(res.status);
  for (const [name, value] of Object.entries(forwardableHeaders(res.headers, "response"))) {
    reply.header(name, value);
  }
  return reply.send(res.body);
}

// ---------------------------------------------------------------------------
// WebSocket relay

/** A link stream opened for an upgrade, waiting for the upgraded socket. */
export class PendingRelay {
  private socket: WebSocket | null = null;
  private readonly queue: [Buffer, boolean][] = [];
  private queued = 0;
  private remoteClose: { code: number; reason: string } | null = null;
  private localClosed = false;

  constructor(
    readonly stream: LinkStream,
    readonly machineId: string,
    private readonly transform: ((data: Buffer) => Buffer) | null,
  ) {
    stream.onMessage((data, binary) => this.fromRemote(data, binary));
    stream.onClose((code, reason) => this.onRemoteClose(code, reason));
    // A client that reads slowly holds the node back through the link's
    // credit, so a busy terminal pauses instead of filling the relay.
    stream.setSinkBacklog?.(() => (this.socket ? this.socket.bufferedAmount : this.queued));
  }

  private fromRemote(data: Buffer, binary: boolean): void {
    const frame = !binary && this.transform ? this.transform(data) : data;
    const socket = this.socket;
    if (!socket) {
      this.queue.push([frame, binary]);
      this.queued += frame.length;
      if (this.queued > RELAY_MAX_BUFFERED)
        this.abandon(1013, "The client didn't connect in time.");
      return;
    }
    if (socket.readyState !== socket.OPEN) return;
    socket.send(frame, { binary });
    if (socket.bufferedAmount > RELAY_MAX_BUFFERED) {
      this.abandon(1013, "The client reads too slowly; reconnect to resume.");
    }
  }

  private onRemoteClose(code: number, reason: string): void {
    if (this.remoteClose) return;
    this.remoteClose = { code, reason };
    const socket = this.socket;
    if (socket && !this.localClosed) {
      const linkLost = code === 1006 || code === 1005 ? null : code;
      socket.close(
        sendableCode(linkLost ?? 1014),
        closeReason(linkLost ? reason : `The link to machine ${this.machineId} closed.`),
      );
    }
  }

  /** Closes both sides, as when the client can't keep up. */
  private abandon(code: number, reason: string): void {
    if (!this.localClosed) {
      this.localClosed = true;
      this.socket?.close(code, reason);
    }
    if (!this.remoteClose) {
      this.remoteClose = { code, reason };
      this.stream.close(code, reason);
    }
  }

  /** Closes the stream when the upgrade never completes. */
  cancel(): void {
    if (this.socket || this.remoteClose) return;
    this.remoteClose = { code: 1001, reason: "" };
    this.stream.close(1001, "The client went away before the upgrade completed.");
  }

  attach(socket: WebSocket): void {
    this.socket = socket;
    socket.on("message", (data, isBinary) => {
      if (this.remoteClose) return;
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      this.stream.send(buf, isBinary);
    });
    socket.on("close", (code, reason) => {
      if (this.localClosed) return;
      this.localClosed = true;
      if (this.remoteClose) return;
      this.remoteClose = { code, reason: reason.toString() };
      this.stream.close(sendableCode(code === 1006 ? 1001 : code), closeReason(reason.toString()));
    });
    for (const [frame, binary] of this.queue.splice(0)) socket.send(frame, { binary });
    this.queued = 0;
    if (this.remoteClose) {
      const { code, reason } = this.remoteClose;
      this.remoteClose = null;
      this.onRemoteClose(code, reason);
    }
  }
}

/** A close code `ws` accepts for `close()`: 1005 and 1006 are reserved. */
export function sendableCode(code: number): number {
  if (code === 1005) return 1000;
  if (code === 1006) return 1001;
  if ((code >= 1000 && code <= 1014 && code !== 1004) || (code >= 3000 && code <= 4999))
    return code;
  return 1011;
}

/** Trims a close reason to the 123 bytes a close frame can carry. */
function closeReason(reason: string): string {
  let out = reason;
  while (Buffer.byteLength(out) > 123) out = out.slice(0, -1);
  return out;
}

/**
 * Tags each event frame of a relayed event stream with the machine it came
 * from, so a client can merge several machines' streams. `hello` frames and
 * frames that aren't JSON pass through unchanged.
 */
export function tagEventFrame(machineId: string) {
  return (data: Buffer): Buffer => {
    let frame: unknown;
    try {
      frame = JSON.parse(data.toString("utf8"));
    } catch {
      return data;
    }
    if (
      typeof frame !== "object" ||
      frame === null ||
      Array.isArray(frame) ||
      (frame as { type?: unknown }).type === "hello" ||
      typeof (frame as { seq?: unknown }).seq !== "number" ||
      (frame as { machine?: unknown }).machine !== undefined
    ) {
      return data;
    }
    return Buffer.from(JSON.stringify({ ...frame, machine: machineId }));
  };
}

const pendingRelays = new WeakMap<FastifyRequest, PendingRelay>();

function isUpgrade(request: FastifyRequest): boolean {
  return (request.headers.upgrade ?? "").toLowerCase() === "websocket";
}

async function openRelay(deps: Deps, request: FastifyRequest): Promise<void> {
  const { target, path } = targetOf(request);
  const resolved = resolveMachine(deps.links, deps.machines, target, path);
  const headers = forwardableHeaders(request.headers, "stream");
  headers[FORWARDED_BY_HEADER] = forwardedBy(headers[FORWARDED_BY_HEADER], deps.machines);
  const req: Omit<LinkRequest, "body" | "method"> = { path: resolved.path, headers };
  if (target.query !== undefined) req.query = target.query;
  const ms = deps.machines?.timeouts?.openMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  let stream: LinkStream;
  try {
    stream = await withTimeout(
      resolved.link.openStream(req),
      ms,
      `Machine ${target.machineId} didn't open /${target.rest} within ${Math.round(ms / 1000)} seconds.`,
      (late) => late.close(1001, "The relay gave up waiting for the stream."),
    );
  } catch (err) {
    throw linkFailure(err, target.machineId);
  }
  // A node tags too: the hub serves its own events as plain frames, and
  // `tagEventFrame` leaves a frame the hub already tagged as it is.
  const events = target.rest.replace(/\/$/, "") === "events";
  const relay = new PendingRelay(
    stream,
    target.machineId,
    events ? tagEventFrame(target.machineId) : null,
  );
  pendingRelays.set(request, relay);
  // An upgrade that fails after this point must not leave the stream open.
  request.raw.socket?.once("close", () => relay.cancel());
}

/**
 * Registers the machine proxy route. It runs in its own plugin scope, where
 * every body arrives as raw bytes, so a forwarded body crosses the link as
 * the client sent it, under the API's usual body size limit.
 */
export async function registerMachineProxy(app: FastifyInstance, deps: Deps): Promise<void> {
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body),
    );
    scope.route({
      method: "GET",
      url: MACHINE_PROXY_PATH,
      config: { aio: { auth: true, ws: "upgrade" } },
      preHandler: async (request) => {
        if (isUpgrade(request)) await openRelay(deps, request);
      },
      handler: (request, reply) => forwardHttp(deps, request, reply),
      wsHandler: (socket, request) => {
        const relay = pendingRelays.get(request);
        pendingRelays.delete(request);
        if (!relay) {
          socket.close(1011, "The relay stream is missing.");
          return;
        }
        relay.attach(socket);
      },
    });
    scope.route({
      method: ["DELETE", "OPTIONS", "PATCH", "POST", "PUT"],
      url: MACHINE_PROXY_PATH,
      config: { aio: { auth: true, ws: false } },
      handler: (request, reply) => forwardHttp(deps, request, reply),
    });
  });
}
