// Serves a `FakeServer` over real HTTP for end-to-end tests, such as the
// apps' Playwright smoke tests: API requests go to the fake, and static
// prefixes serve built renderers. Node only; the browser-safe test doubles
// are in `@agentbox/ui/testing`. WebSocket upgrades are refused, so an app
// under test shows its event stream as offline.
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { extname, join, normalize } from "node:path";
import type { FakeServer } from "./FakeServer";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

export interface ServeFakeOptions {
  /** URL prefixes, such as `/boxes/`, mapped to directories to serve files from. */
  static?: Record<string, string>;
  /** The port to listen on; 0, the default, picks a free one. */
  port?: number;
  /**
   * A key and certificate, PEM, to serve HTTPS with, as the real server
   * does. The apps pin the certificate, so write it to the data directory
   * they read.
   */
  tls?: { key: string; cert: string };
}

export interface ServedFake {
  /** The origin, such as `https://127.0.0.1:41234`, or `http://` without `tls`. */
  url: string;
  /** Every request as `METHOD /path AUTHORIZATION`, for header checks. */
  requests: string[];
  server: Server;
  close(): Promise<void>;
}

/** Returns the file path for a URL path under a static prefix, or null outside every prefix. */
export function staticFile(
  pathname: string,
  prefixes: Record<string, string>,
): string | null | "forbidden" {
  for (const [prefix, dir] of Object.entries(prefixes)) {
    if (!pathname.startsWith(prefix)) continue;
    const rel = normalize(decodeURIComponent(pathname.slice(prefix.length)) || "index.html");
    if (rel.startsWith("..") || rel.startsWith("/")) return "forbidden";
    return join(dir, rel);
  }
  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Starts an HTTP or HTTPS server on 127.0.0.1 in front of `fake`. */
export async function serveFake(
  fake: FakeServer,
  options: ServeFakeOptions = {},
): Promise<ServedFake> {
  const requests: string[] = [];
  const listener: RequestListener = (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      requests.push(`${req.method} ${url.pathname} ${req.headers.authorization ?? ""}`);
      if (url.pathname.startsWith("/api/")) {
        const body = await readBody(req);
        const answer = await fake.fetch(url.href, {
          method: req.method,
          body: body === "" ? undefined : body,
        });
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(await answer.text());
        return;
      }
      const file = staticFile(url.pathname, options.static ?? {});
      if (file === "forbidden") {
        res.writeHead(400).end();
        return;
      }
      if (file === null) {
        res.writeHead(404).end();
        return;
      }
      try {
        const data = await readFile(file);
        res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
        res.end(data);
      } catch {
        res.writeHead(404).end();
      }
    })().catch((err: unknown) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "internal", message: String(err) } }));
    });
  };
  const server: Server = options.tls
    ? createTlsServer({ key: options.tls.key, cert: options.tls.cert }, listener)
    : createServer(listener);
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The fake server has no port.");
  return {
    url: `${options.tls ? "https" : "http"}://127.0.0.1:${address.port}`,
    requests,
    server,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
