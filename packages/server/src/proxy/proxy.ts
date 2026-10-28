// The dev-server proxy: `http://<port>.<hostKey>.localhost:<serverPort>/...`
// forwards HTTP and WebSocket upgrades to the engine of the box's container,
// at `/proxy/<port>/...`. The listener is on loopback, so the proxy needs no
// authentication; the engine call carries the engine token.
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

function upstreamHeaders(req: http.IncomingMessage, token: string): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  headers.authorization = `Bearer ${token}`;
  headers["x-forwarded-host"] = req.headers.host;
  return headers;
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
        path: `/proxy/${parsed.port}${req.url ?? "/"}`,
        headers: upstreamHeaders(req, target.token),
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.statusMessage, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", (err) => plainError(res, 502, `The engine is not reachable: ${err.message}`));
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
      const headers = upstreamHeaders(req, target.token);
      const lines = [`${req.method ?? "GET"} /proxy/${parsed.port}${req.url ?? "/"} HTTP/1.1`];
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
