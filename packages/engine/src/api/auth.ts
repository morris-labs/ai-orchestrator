// Bearer-token checks for the engine API.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Compares two strings in constant time. */
export function tokensEqual(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** Reads the token from `Authorization: Bearer <token>`, or `null`. */
export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const m = value ? /^Bearer\s+(.+)$/i.exec(value.trim()) : null;
  return m ? (m[1] as string) : null;
}

/**
 * True when the request carries the engine token in its `Authorization`
 * header. WebSocket upgrades authenticate the same way: a `token` query
 * parameter is never accepted, so the token stays out of URLs.
 */
export function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const header = bearerToken(req.headers.authorization);
  return header !== null && tokensEqual(header, expected);
}

/**
 * The header the server uses to send the engine token on `/proxy` requests,
 * so the browser's own `Authorization` header reaches the proxied app.
 */
export const ENGINE_TOKEN_HEADER = "x-aio-engine-token";

/** The token in the engine-token header, or `null`. */
export function headerToken(value: string | string[] | undefined): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed ? trimmed : null;
}

/** True when an `Authorization` value is the engine token in any spelling `isAuthorized` accepts. */
export function isEngineBearer(value: string | string[] | undefined, expected: string): boolean {
  const token = bearerToken(value);
  return token !== null && tokensEqual(token, expected);
}

/**
 * True when a `/proxy` request, HTTP or WebSocket upgrade, carries the engine
 * token: in `x-aio-engine-token`, which the server sends, or in
 * `Authorization`.
 */
export function isProxyAuthorized(req: IncomingMessage, expected: string): boolean {
  const header = headerToken(req.headers[ENGINE_TOKEN_HEADER]);
  if (header !== null && tokensEqual(header, expected)) return true;
  return isAuthorized(req, expected);
}

/**
 * Removes the value of a `token` query parameter from a URL, for logs. The
 * engine accepts no such parameter, but a stray one from an old client or a
 * proxied app stays out of the log.
 */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]*/g, "$1[redacted]");
}
