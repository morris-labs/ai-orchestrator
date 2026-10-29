// The dev-server proxy: `http://<port>.<hostKey>.localhost:<serverPort>/...`
// forwards HTTP and WebSocket upgrades to the engine of the box's container,
// at `/proxy/<port>/...`. The listener is on loopback, so the proxy needs no
// authentication; the engine call carries the engine token in its own
// header, never in the URL and never in place of the browser's own
// `Authorization` header.
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

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
}

export type ProxyResolver = (hostKey: string) => Promise<ProxyTarget | null>;

/** The header that carries the engine token, so the browser's `Authorization` passes untouched. */
export const ENGINE_TOKEN_HEADER = "x-agentbox-engine-token";

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
 * `x-agentbox-engine-token`, which the engine strips, on plain requests and
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

function plainError(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(`${message}\n`);
}

export class DevServerProxy {
  constructor(private readonly resolve: ProxyResolver) {}

  /** True when the request is for the proxy rather than the API. */
  matches(req: http.IncomingMessage): boolean {
    return parseProxyHost(req.headers.host) !== null;
  }

  async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsed = parseProxyHost(req.headers.host);
    if (!parsed) return plainError(res, 400, "Not a proxy host.");
    let target: ProxyTarget | null;
    try {
      target = await this.resolve(parsed.hostKey);
    } catch {
      target = null;
    }
    if (!target) return plainError(res, 502, `No running box has the host key ${parsed.hostKey}.`);
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: target.enginePort,
        method: req.method,
        path: upstreamPath(parsed.port, req.url),
        headers: upstreamHeaders(req, target.token),
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.statusMessage, up.headers);
        up.pipe(res);
      },
    );
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
    const parsed = parseProxyHost(req.headers.host);
    let target: ProxyTarget | null = null;
    if (parsed) {
      try {
        target = await this.resolve(parsed.hostKey);
      } catch {
        target = null;
      }
    }
    if (!parsed || !target) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.connect(target.enginePort, "127.0.0.1", () => {
      const headers = upstreamHeaders(req, target.token, true);
      const lines = [`${req.method ?? "GET"} ${upstreamPath(parsed.port, req.url)} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
      }
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  }
}

/**
 * Builds a resolver from a box lookup and an engine lookup, with a short
 * cache so a page load does not list boxes for every asset.
 */
export function cachedResolver(lookup: ProxyResolver, ttlMs = 2000): ProxyResolver {
  const cache = new Map<string, { at: number; target: ProxyTarget | null }>();
  return async (hostKey) => {
    const hit = cache.get(hostKey);
    if (hit && Date.now() - hit.at < ttlMs) return hit.target;
    const target = await lookup(hostKey);
    cache.set(hostKey, { at: Date.now(), target });
    return target;
  };
}
