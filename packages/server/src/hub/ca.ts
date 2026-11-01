// The hub's certificate authority and link identity, in `DATA_DIR/hub/`:
//
//   ca.key, ca.crt      The authority that signs node client certificates
//                       and the hub's own link certificate. The key has
//                       mode 0600 and never leaves the hub.
//   link.key, link.crt  The certificate the link listener serves, which
//                       each node pins when it enrolls.
//
// And a node's side of the link, in `DATA_DIR/link/`:
//
//   client.key, client.crt  The node's client certificate, signed by the
//                           hub's authority. The key has mode 0600 and never
//                           leaves the node.
//   hub-ca.crt, hub.crt     The hub's authority and its pinned link certificate.
//   node.json               The hub URL, this machine's id, and its name.
import { X509Certificate, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCertificate } from "@aio/contracts/tls";
import { z } from "zod";

/** The common name of the hub's certificate authority. */
export const HUB_CA_NAME = "AI Orchestrator hub CA";
/** The common name of the hub's link certificate. */
export const HUB_LINK_NAME = "AI Orchestrator hub";
/** The prefix of a node client certificate's common name; the machine id follows. */
export const NODE_CERT_PREFIX = "aio-node:";
/** How long the authority and the certificates it signs are valid: 10 years. */
const CERT_DAYS = 3650;

/** Writes `text` to `file` with `mode` through a temporary file, so a reader never sees half. */
export async function writeAtomic(file: string, text: string | Buffer, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  await writeFile(tmp, text, { mode, flag: "wx" });
  await chmod(tmp, mode);
  await rename(tmp, file);
}

/** Makes `dir` with mode 0700, and tightens an existing one that others can read. */
export async function privateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const mode = (await stat(dir)).mode & 0o777;
  if (mode & 0o077) await chmod(dir, mode & 0o700);
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** A key pair and certificate, PEM. */
export interface PemIdentity {
  key: string;
  cert: string;
}

/** The hub's authority and link identity. */
export interface HubIdentity {
  ca: PemIdentity;
  link: PemIdentity;
  /** The SHA-256 fingerprint of the link certificate, as nodes pin it. */
  linkFingerprint: string;
}

function newKeyPair() {
  return generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function pkcs8(key: ReturnType<typeof newKeyPair>["privateKey"]): string {
  return key.export({ type: "pkcs8", format: "pem" }) as string;
}

/** True when `cert` is signed by `ca` and matches `key`. */
function validPair(ca: PemIdentity, pair: PemIdentity): boolean {
  try {
    const caCert = new X509Certificate(ca.cert);
    const cert = new X509Certificate(pair.cert);
    return cert.checkPrivateKey(createPrivateKey(pair.key)) && cert.verify(caCert.publicKey);
  } catch {
    return false;
  }
}

/**
 * Reads the hub's authority and link certificate from `dir`, or creates
 * them. A missing or broken authority is replaced, which invalidates every
 * node certificate it signed; a missing or broken link certificate is
 * signed again, which makes every node's pin fail until it enrolls again.
 */
export async function loadOrCreateHubIdentity(dir: string, now = new Date()): Promise<HubIdentity> {
  await privateDir(dir);
  const caKeyFile = path.join(dir, "ca.key");
  const caCertFile = path.join(dir, "ca.crt");
  const linkKeyFile = path.join(dir, "link.key");
  const linkCertFile = path.join(dir, "link.crt");

  let ca: PemIdentity | null = null;
  const [caKey, caCert] = await Promise.all([readOptional(caKeyFile), readOptional(caCertFile)]);
  if (caKey && caCert) {
    try {
      const x509 = new X509Certificate(caCert);
      if (x509.ca && x509.checkPrivateKey(createPrivateKey(caKey))) ca = { key: caKey, cert: caCert };
    } catch {
      ca = null;
    }
  }
  if (!ca) {
    const pair = newKeyPair();
    const cert = createCertificate({
      commonName: HUB_CA_NAME,
      publicKey: pair.publicKey,
      signingKey: pair.privateKey,
      ca: true,
      now,
      days: CERT_DAYS,
    });
    ca = { key: pkcs8(pair.privateKey), cert };
    await writeAtomic(caKeyFile, ca.key, 0o600);
    await writeAtomic(caCertFile, ca.cert, 0o644);
  } else if (((await stat(caKeyFile)).mode & 0o777) !== 0o600) {
    await chmod(caKeyFile, 0o600);
  }

  let link: PemIdentity | null = null;
  const [linkKey, linkCert] = await Promise.all([
    readOptional(linkKeyFile),
    readOptional(linkCertFile),
  ]);
  if (linkKey && linkCert && validPair(ca, { key: linkKey, cert: linkCert })) {
    link = { key: linkKey, cert: linkCert };
  }
  if (!link) {
    const pair = newKeyPair();
    const caPrivate = createPrivateKey(ca.key);
    const cert = createCertificate({
      commonName: HUB_LINK_NAME,
      publicKey: pair.publicKey,
      signingKey: caPrivate,
      issuer: { commonName: HUB_CA_NAME, publicKey: createPublicKey(caPrivate) },
      ca: false,
      usages: ["serverAuth"],
      now,
      days: CERT_DAYS,
    });
    link = { key: pkcs8(pair.privateKey), cert };
    await writeAtomic(linkKeyFile, link.key, 0o600);
    await writeAtomic(linkCertFile, link.cert, 0o644);
  }
  return { ca, link, linkFingerprint: new X509Certificate(link.cert).fingerprint256 };
}

/**
 * Signs a node's client certificate for `publicKeyPem`, an ECDSA P-256
 * public key in SPKI PEM. Throws when the key is another kind.
 */
export function issueNodeCertificate(
  ca: PemIdentity,
  machineId: string,
  publicKeyPem: string,
  now = new Date(),
): string {
  let publicKey;
  try {
    publicKey = createPublicKey(publicKeyPem);
  } catch {
    throw new Error("The node's public key isn't a PEM public key.");
  }
  if (publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("The node's public key must be an ECDSA P-256 key.");
  }
  const caPrivate = createPrivateKey(ca.key);
  return createCertificate({
    commonName: `${NODE_CERT_PREFIX}${machineId}`,
    publicKey,
    signingKey: caPrivate,
    issuer: { commonName: HUB_CA_NAME, publicKey: createPublicKey(caPrivate) },
    ca: false,
    usages: ["clientAuth"],
    now,
    days: CERT_DAYS,
  });
}

/** A new node key pair: the private key PEM to keep, and the public key PEM to send. */
export function newNodeKey(): { key: string; publicKey: string } {
  const pair = newKeyPair();
  return {
    key: pkcs8(pair.privateKey),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }) as string,
  };
}

// ---------------------------------------------------------------------------
// The node's side

export const NodeLinkConfigSchema = z.object({
  hubUrl: z.string(),
  machineId: z.string(),
  name: z.string(),
  hubFingerprint: z.string(),
  joinedAt: z.string(),
});
export type NodeLinkConfig = z.infer<typeof NodeLinkConfigSchema>;

/** What a node keeps to reach its hub. */
export interface NodeLinkFiles {
  config: NodeLinkConfig;
  clientKey: string;
  clientCert: string;
  hubCa: string;
  hubCert: string;
}

/** Reads the node's link files from `dir`, or returns `null` when the node hasn't joined a hub. */
export async function readNodeLinkFiles(dir: string): Promise<NodeLinkFiles | null> {
  const [json, clientKey, clientCert, hubCa, hubCert] = await Promise.all(
    ["node.json", "client.key", "client.crt", "hub-ca.crt", "hub.crt"].map((f) =>
      readOptional(path.join(dir, f)),
    ),
  );
  if (!json || !clientKey || !clientCert || !hubCa || !hubCert) return null;
  const parsed = NodeLinkConfigSchema.safeParse(JSON.parse(json));
  if (!parsed.success) return null;
  return { config: parsed.data, clientKey, clientCert, hubCa, hubCert };
}

/** Writes the node's link files to `dir`; the key gets mode 0600. */
export async function writeNodeLinkFiles(dir: string, files: NodeLinkFiles): Promise<void> {
  await privateDir(dir);
  await writeAtomic(path.join(dir, "client.key"), files.clientKey, 0o600);
  await writeAtomic(path.join(dir, "client.crt"), files.clientCert, 0o644);
  await writeAtomic(path.join(dir, "hub-ca.crt"), files.hubCa, 0o644);
  await writeAtomic(path.join(dir, "hub.crt"), files.hubCert, 0o644);
  // Last: its presence means the other files are in place.
  await writeAtomic(
    path.join(dir, "node.json"),
    `${JSON.stringify(files.config, null, 2)}\n`,
    0o644,
  );
}
