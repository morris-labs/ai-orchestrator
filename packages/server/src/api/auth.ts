// The server's bearer token, the session cookie, and the request check.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { HOME_PATHS } from "@agentbox/contracts";
import { dataPath } from "../records/env.js";

export const SESSION_COOKIE = "agentbox_session";

/**
 * Reads `server.token` in the data directory (`~/.claude-box` unless
 * `dataDir` is set), or creates it with mode 0600 on first start. Tightens
 * the mode of an existing file that others can read.
 */
export async function loadOrCreateToken(home: string, dataDir?: string): Promise<string> {
  const file = dataPath({ home, dataDir }, HOME_PATHS.serverToken);
  try {
    const token = (await readFile(file, "utf8")).trim();
    if (token.length >= 32) {
      const mode = (await stat(file)).mode & 0o777;
      if (mode !== 0o600) await chmod(file, 0o600);
      return token;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return token;
}

/** The cookie value: derived from the token, so it changes when the token does. */
export function sessionValue(token: string): string {
  return createHmac("sha256", token).update(SESSION_COOKIE).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Reads one cookie from a `Cookie` header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export interface AuthInput {
  authorization?: string;
  cookie?: string;
  /** The `token` query parameter; accepted only on WebSocket routes. */
  queryToken?: string;
}

/** True when the request carries the bearer token. */
export function hasBearer(input: AuthInput, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(input.authorization ?? "");
  return m !== null && safeEqual((m[1] as string).trim(), token);
}

/** True when the request carries the bearer token, the session cookie, or (WebSocket) the token query. */
export function isAuthorized(input: AuthInput, token: string): boolean {
  if (hasBearer(input, token)) return true;
  const cookie = readCookie(input.cookie, SESSION_COOKIE);
  if (cookie !== undefined && safeEqual(cookie, sessionValue(token))) return true;
  return input.queryToken !== undefined && safeEqual(input.queryToken, token);
}

/** The `Set-Cookie` header value for `auth.session`. */
export function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${sessionValue(token)}; HttpOnly; SameSite=Strict; Path=/`;
}
