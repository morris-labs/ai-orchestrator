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
 * header or, when `allowQuery` is set (WebSocket upgrades), in a `token`
 * query parameter.
 */
export function isAuthorized(req: IncomingMessage, expected: string, allowQuery: boolean): boolean {
  const header = bearerToken(req.headers.authorization);
  if (header !== null && tokensEqual(header, expected)) return true;
  if (!allowQuery) return false;
  const token = new URL(req.url ?? "/", "http://engine").searchParams.get("token");
  return token !== null && tokensEqual(token, expected);
}

/**
 * The header the server uses to send the engine token on `/proxy` requests,
 * so the browser's own `Authorization` header reaches the proxied app.
 */
export const ENGINE_TOKEN_HEADER = "x-agentbox-engine-token";

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
 * True when a `/proxy` request carries the engine token: in
 * `x-agentbox-engine-token`, or any way `isAuthorized` accepts.
 */
export function isProxyAuthorized(
  req: IncomingMessage,
  expected: string,
  allowQuery: boolean,
): boolean {
  const header = headerToken(req.headers[ENGINE_TOKEN_HEADER]);
  if (header !== null && tokensEqual(header, expected)) return true;
  return isAuthorized(req, expected, allowQuery);
}

/** Removes the value of a `token` query parameter from a URL, for logs. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]*/g, "$1[redacted]");
}
