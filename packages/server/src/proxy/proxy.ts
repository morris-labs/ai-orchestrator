// The dev-server proxy: `http://<port>.<hostKey>.localhost:<serverPort>/...`
// forwards HTTP and WebSocket upgrades to the engine of the box's container,
// at `/proxy/<port>/...`. The listener is on loopback, so the proxy needs no
// token; the engine call carries the engine token in its own header, never
// in the URL and never in place of the browser's own `Authorization` header.
//
// Loopback is no boundary for a browser, so the proxy refuses what a page on
// another site can send: a request whose `Origin` isn't the proxy host
// itself, or whose `Sec-Fetch-Site` is anything but `same-origin` or `none`
// (the person typed the address, or an app opened it). It also forwards only
// to the ports the box listens on or the project maps, so a page can't reach
// the engine or another service in the container through it.
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { Listener } from "@aio/contracts";

/** Parses a `Host` header of the form `<port>.<hostKey>.localhost[:N]`. */
export function parseProxyHost(host: string | undefined): { port: number; hostKey: string } | null {
  if (!host) return null;
  const m = /^(\d{1,5})\.([a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)\.localhost(?::\d+)?$/i.exec(host);
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1 || port > 65535) return null;
  return { port, hostKey: (m[2] as string).toLowerCase() };
}

/** Where a proxied request goes: the engine's host port and token. */
export interface ProxyTarget {
  enginePort: number;
  token: string;
  /**
   * True when the box serves `port`: a port the engine saw the box listen
   * on, or a container port of the project's TCP maps. Called on every
   * request, so it can read live listener state.
   */
  allowsPort(port: number): boolean;
}

/**
 * The port check of a box: the ports its own processes listen on, from the
 * engine's port discovery (a listener the engine can't tie to a box, such
 * as the engine itself, doesn't count), plus the project's mapped ports.
 */
export function proxyPorts(
  boxId: string,
  listeners: () => readonly Pick<Listener, "port" | "boxId">[],
  mappedPorts: readonly number[],
): Pick<ProxyTarget, "allowsPort"> {
  const mapped = new Set(mappedPorts);
  return {
    allowsPort: (port) =>
      mapped.has(port) || listeners().some((l) => l.port === port && l.boxId === boxId),
  };
}

export type ProxyResolver = (hostKey: string) => Promise<ProxyTarget | null>;

/** The header that carries the engine token, so the browser's `Authorization` passes untouched. */
export const ENGINE_TOKEN_HEADER = "x-aio-engine-token";

/** Hop-by-hop headers (RFC 9110 section 7.6.1), which a proxy must not forward. */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/**
 * The headers for the engine. The browser's `Authorization` header belongs
 * to the dev server and passes unchanged; the engine token travels in
 * `x-aio-engine-token`, which the engine strips, on plain requests and
 * upgrades alike. An upgrade keeps `Connection` and `Upgrade`.
 */
export function upstreamHeaders(
  req: http.IncomingMessage,
  token: string,
  upgrade = false,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  const named = String(req.headers.connection ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "" && !(upgrade && h === "upgrade"));
  for (const name of [...HOP_BY_HOP, ...named]) {
    if (upgrade && (name === "connection" || name === "upgrade")) continue;
    delete headers[name];
  }
  headers[ENGINE_TOKEN_HEADER] = token;
  headers["x-forwarded-host"] = req.headers.host;
  return headers;
}

/** The engine path for a proxied request, with the browser's query unchanged. */
export function upstreamPath(port: number, url: string | undefined): string {
  return `/proxy/${port}${url ?? "/"}`;
}

/**
 * Why a browser request didn't come from the person or from a page on the
 * proxy host itself, or `null` when it did. A request with neither `Origin`
 * nor `Sec-Fetch-Site` comes from a client that isn't a browser and passes.
 */
export function crossSiteReason(req: http.IncomingMessage): string | null {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    return `The proxy refuses ${site} requests.`;
  }
  const origin = req.headers.origin;
  if (origin === undefined) return null;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return "The proxy refuses requests from an opaque origin.";
  }
  if (host === "" || host.toLowerCase() !== (req.headers.host ?? "").toLowerCase()) {
    return `The proxy refuses requests from ${origin}.`;
  }
  return null;
}

const STATUS_LINES: Record<number, string> = {
  400: "400 Bad Request",
  403: "403 Forbidden",
  502: "502 Bad Gateway",
};

function plainError(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(`${message}\n`);
}

type Resolution =
  { ok: true; port: number; target: ProxyTarget } | { ok: false; status: number; message: string };

export class DevServerProxy {
  /** Every socket the proxy holds open, so `close()` can end them. */
  private readonly sockets = new Set<Duplex>();

  constructor(private readonly resolve: ProxyResolver) {}

  /**
   * Destroys every proxied connection. A server's own `close()` leaves
   * upgraded sockets open, and the upstream sockets are the proxy's.
   */
  close(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  private track(socket: Duplex): void {
    if (socket.destroyed || this.sockets.has(socket)) return;
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  /** The target of a request, or the status and message to refuse it with. */
  private async route(req: http.IncomingMessage): Promise<Resolution> {
    const parsed = parseProxyHost(req.headers.host);
    if (!parsed) return { ok: false, status: 400, message: "Not a proxy host." };
    const crossSite = crossSiteReason(req);
    if (crossSite) return { ok: false, status: 403, message: crossSite };
    let target: ProxyTarget | null;
    try {
      target = await this.resolve(parsed.hostKey);
    } catch {
      target = null;
    }
    if (!target) {
      return {
        ok: false,
        status: 502,
        message: `No running box has the host key ${parsed.hostKey}.`,
      };
    }
    if (!target.allowsPort(parsed.port)) {
      return {
        ok: false,
        status: 403,
        message: `Box ${parsed.hostKey} doesn't listen on port ${parsed.port}.`,
      };
    }
    return { ok: true, port: parsed.port, target };
  }

  /** True when the request is for the proxy rather than the API. */
  matches(req: http.IncomingMessage): boolean {
    return parseProxyHost(req.headers.host) !== null;
  }

  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.track(req.socket);
    const found = await this.route(req);
    if (!found.ok) return plainError(res, found.status, found.message);
    const { port, target } = found;
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: target.enginePort,
        method: req.method,
        path: upstreamPath(port, req.url),
        headers: upstreamHeaders(req, target.token),
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.statusMessage, up.headers);
        up.pipe(res);
        // `pipe` doesn't end the response when the engine drops mid-stream, so
        // destroy it to let the browser see the failure and reconnect.
        up.once("close", () => {
          if (!up.complete) res.destroy();
        });
      },
    );
    upstream.on("socket", (socket) => this.track(socket));
    upstream.on("error", (err) =>
      plainError(res, 502, `The engine is not reachable: ${err.message}`),
    );
    // A browser that goes away takes the engine request with it.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  }

  async handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    this.track(socket);
    // Node removes its own socket error listener before `upgrade`, so a client
    // reset during routing would otherwise stop the server.
    socket.on("error", () => socket.destroy());
    const found = await this.route(req);
    if (!found.ok) {
      socket.end(`HTTP/1.1 ${STATUS_LINES[found.status]}\r\nConnection: close\r\n\r\n`);
      return;
    }
    const { port, target } = found;
    const upstream = net.connect(target.enginePort, "127.0.0.1", () => {
      const headers = upstreamHeaders(req, target.token, true);
      const lines = [`${req.method ?? "GET"} ${upstreamPath(port, req.url)} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    this.track(upstream);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    // Either side closing ends the other, so neither stays open half-way.
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  }
}

/** The most host keys `cachedResolver` keeps. */
export const RESOLVER_CACHE_MAX = 256;

/**
 * Builds a resolver from a box lookup and an engine lookup, with a short
 * cache so a page load does not list boxes for every asset. Every miss drops
 * the expired entries, and the cache holds at most `maxEntries` host keys,
 * oldest out first, so requests for made-up host keys can't grow it.
 */
export function cachedResolver(
  lookup: ProxyResolver,
  ttlMs = 2000,
  maxEntries = RESOLVER_CACHE_MAX,
): ProxyResolver {
  const cache = new Map<string, { at: number; target: ProxyTarget | null }>();
  return async (hostKey) => {
    const hit = cache.get(hostKey);
    if (hit && Date.now() - hit.at < ttlMs) return hit.target;
    const target = await lookup(hostKey);
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (now - entry.at >= ttlMs) cache.delete(key);
    }
    cache.delete(hostKey);
    cache.set(hostKey, { at: now, target });
    for (const key of cache.keys()) {
      if (cache.size <= maxEntries) break;
      cache.delete(key);
    }
    return target;
  };
}
