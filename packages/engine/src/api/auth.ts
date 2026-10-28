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

/** Removes the value of a `token` query parameter from a URL, for logs. */
export function redactUrl(url: string): string {
  return url.replace(/([?&]token=)[^&]*/g, "$1[redacted]");
}
