// The server's bearer token, the session cookie, and the request check.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  // A new 0600 file renamed over the old one: writing in place would keep an
  // existing file's wider mode until the chmod.
  const tmp = `${file}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  await writeFile(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
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
    if (part.slice(0, eq).trim() !== name) continue;
    // Any page on the same host can set a cookie, ports aside, so a bad
    // escape is skipped rather than failing the request.
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface AuthInput {
  authorization?: string;
  cookie?: string;
}

/** True when the request carries the bearer token. */
export function hasBearer(input: AuthInput, token: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(input.authorization ?? "");
  return m !== null && safeEqual((m[1] as string).trim(), token);
}

/**
 * True when the request carries the bearer token or the session cookie. A
 * WebSocket upgrade authenticates the same way: a `token` query parameter is
 * never accepted, so the token stays out of URLs.
 */
export function isAuthorized(input: AuthInput, token: string): boolean {
  if (hasBearer(input, token)) return true;
  const cookie = readCookie(input.cookie, SESSION_COOKIE);
  return cookie !== undefined && safeEqual(cookie, sessionValue(token));
}

/**
 * The `Set-Cookie` header value for `auth.session`. Over HTTPS the cookie
 * is `Secure`, so the browser never sends it to a plain HTTP listener on the
 * same host, such as the dev-server proxy.
 */
export function sessionCookieHeader(token: string, secure = false): string {
  const flags = secure ? "; Secure" : "";
  return `${SESSION_COOKIE}=${sessionValue(token)}; HttpOnly; SameSite=Strict; Path=/${flags}`;
}
