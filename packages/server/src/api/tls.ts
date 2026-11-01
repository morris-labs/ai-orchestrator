// The server's TLS identity: `server.key` and `server.crt` in the data
// directory. Clients pin `server.crt`, so a process that binds the server
// port while the server is down can't pose as it.
import { X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { HOME_PATHS } from "@aio/contracts";
import { createServerIdentity, type TlsIdentity } from "@aio/contracts/tls";
import { dataDirOf, dataPath } from "../records/env.js";

/** A certificate this close to its end is replaced at start. */
const RENEW_BEFORE_MS = 30 * 86400_000;

/** Reads a usable identity, or `null` when the files are missing, broken, or expiring. */
async function readIdentity(keyFile: string, certFile: string, now: Date) {
  let key: string;
  let cert: string;
  try {
    [key, cert] = await Promise.all([readFile(keyFile, "utf8"), readFile(certFile, "utf8")]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const x509 = new X509Certificate(cert);
    const privateKey = createPrivateKey(key);
    if (!x509.checkPrivateKey(privateKey) || !x509.verify(createPublicKey(privateKey))) return null;
    if (Date.parse(x509.validTo) - now.getTime() < RENEW_BEFORE_MS) return null;
    if (Date.parse(x509.validFrom) > now.getTime()) return null;
  } catch {
    return null;
  }
  return { key, cert };
}

/** Writes `text` to `file` with `mode` through a temporary file, so a reader never sees half. */
async function writeAtomic(file: string, text: string, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode });
  await chmod(tmp, mode);
  await rename(tmp, file);
}

/**
 * Reads `server.key` and `server.crt` in the data directory, or creates them
 * on first start, and whenever they are unreadable, don't match, or expire
 * within 30 days. The data directory gets mode 0700 and the key 0600; an
 * existing directory or key that others can read is tightened.
 */
export async function loadOrCreateTlsIdentity(
  home: string,
  dataDir?: string,
  now: Date = new Date(),
): Promise<TlsIdentity> {
  const env = { home, dataDir };
  const dir = dataDirOf(env);
  const keyFile = dataPath(env, HOME_PATHS.serverKey);
  const certFile = dataPath(env, HOME_PATHS.serverCert);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dirMode = (await stat(dir)).mode & 0o777;
  if (dirMode & 0o077) await chmod(dir, dirMode & 0o700);

  const existing = await readIdentity(keyFile, certFile, now);
  if (existing) {
    if (((await stat(keyFile)).mode & 0o777) !== 0o600) await chmod(keyFile, 0o600);
    return existing;
  }
  const identity = createServerIdentity({ now });
  // The key goes first: a client that reads the new certificate while the
  // old key is still in place would only fail one handshake.
  await writeAtomic(keyFile, identity.key, 0o600);
  await writeAtomic(certFile, identity.cert, 0o644);
  return identity;
}

/** The certificate file clients pin, for messages and docs. */
export function serverCertPath(home: string, dataDir?: string): string {
  return path.resolve(dataPath({ home, dataDir }, HOME_PATHS.serverCert));
}
