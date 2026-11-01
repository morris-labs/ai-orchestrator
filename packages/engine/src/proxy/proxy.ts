// `/proxy/:port/*`: forwards HTTP requests and WebSocket upgrades to
// `127.0.0.1:<port>` inside the container. Only the path prefix and the
// engine's own credentials are removed; everything else passes unchanged.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { ApiError } from "@aio/contracts";
import { ENGINE_TOKEN_HEADER, isEngineBearer } from "../api/auth.js";
import type { Logger } from "../api/core-interface.js";

export const PROXY_PREFIX = "/proxy/";

export interface ProxyTarget {
  port: number;
  /** The path and query to send upstream, starting with `/`. */
  path: string;
}

/**
 * Splits `/proxy/<port>/<rest>?<query>` into the port and the upstream path.
 * The query passes unchanged: the engine token never travels in it. Returns
 * `null` when the URL isn't a proxy URL or the port is out of range.
 */
export function parseProxyUrl(url: string): ProxyTarget | null {
  const m = /^\/proxy\/(\d{1,5})(\/[^?]*)?(\?.*)?$/.exec(url);
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1 || port > 65535) return null;
  return { port, path: `${m[2] ?? "/"}${m[3] ?? ""}` };
}

/** True when a header carries the engine's credential and must not go upstream. */
export function isEngineCredential(name: string, value: string, engineToken: string): boolean {
  const n = name.toLowerCase();
  if (n === ENGINE_TOKEN_HEADER) return true;
  return n === "authorization" && isEngineBearer(value, engineToken);
}

/**
 * Copies the headers, minus the engine's credential: the
 * `x-aio-engine-token` header, and an `Authorization` header that
 * carries the engine token in any spelling the engine accepts. The browser's
 * own `Authorization` header passes through.
 */
export function forwardHeaders(
  req: IncomingMessage,
  engineToken: string,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  delete headers[ENGINE_TOKEN_HEADER];
  const auth = headers.authorization;
  if (typeof auth === "string" && isEngineCredential("authorization", auth, engineToken)) {
    delete headers.authorization;
  }
  return headers;
}

function errorBody(message: string): string {
  const body: ApiError = { error: { code: "not_found", message } };
  return JSON.stringify(body);
}

export interface ProxyOptions {
  engineToken: string;
  log: Logger;
  /** The upstream host; tests leave it at the default. */
  host?: string;
}

/** Forwards one HTTP request. Answers 502 when nothing listens on the port. */
export function proxyHttp(
  req: IncomingMessage,
  res: ServerResponse,
  target: ProxyTarget,
  options: ProxyOptions,
): void {
  const upstream = http.request({
    host: options.host ?? "127.0.0.1",
    port: target.port,
    method: req.method,
    path: target.path,
    headers: forwardHeaders(req, options.engineToken),
  });
  upstream.on("response", (up) => {
    res.writeHead(up.statusCode ?? 502, up.statusMessage, up.rawHeaders);
    up.pipe(res);
  });
  upstream.on("error", (err) => {
    options.log.debug("Proxy upstream error", { port: target.port, error: String(err) });
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      res.end(errorBody(`Nothing answered on port ${target.port} in the container.`));
    } else {
      res.destroy();
    }
  });
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

/**
 * Forwards a WebSocket (or any HTTP upgrade) by replaying the request head to
 * the upstream port and piping the raw sockets together.
 */
export function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: ProxyTarget,
  options: ProxyOptions,
): void {
  const upstream = net.connect(target.port, options.host ?? "127.0.0.1");
  const fail = (err: Error) => {
    options.log.debug("Proxy upgrade error", { port: target.port, error: String(err) });
    if (socket.writable && !upstreamConnected) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    } else {
      socket.destroy();
    }
    upstream.destroy();
  };
  let upstreamConnected = false;
  upstream.on("error", fail);
  socket.on("error", () => upstream.destroy());
  upstream.on("connect", () => {
    upstreamConnected = true;
    const lines = [`${req.method ?? "GET"} ${target.path} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i] as string;
      const value = req.rawHeaders[i + 1] as string;
      if (isEngineCredential(name, value, options.engineToken)) continue;
      lines.push(`${name}: ${value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  socket.on("close", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
}
