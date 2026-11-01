// The hub's machine registry and enrollment codes, in SQLite (migration 6),
// and the proofs that bind an enrollment to the code and to the hub's
// certificate.
//
// Enrollment is trust on first use, made safe by the code. The node connects
// to the hub's link port without checking its certificate, and proves it
// knows the code with an HMAC over the certificate it saw. A program in the
// middle would present its own certificate, so the hub's check fails, and
// it can't compute a new proof without the code. The hub proves it knows the
// code too, so a node never pins a certificate from a hub that didn't issue
// its code.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Machine } from "@aio/contracts";
import type { SqlDatabase } from "../api/core-interface.js";

/** How long an enrollment code is valid: 10 minutes. */
export const ENROLLMENT_CODE_TTL_MS = 10 * 60_000;

/** Crockford's base32 alphabet: no I, L, O, or U, so a code reads aloud cleanly. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A new code: 16 characters, 80 random bits, in four groups, such as `7K2Q-M9XD-4HPA-R3TB`. */
export function newEnrollmentCode(): string {
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += CODE_ALPHABET[(bytes[i] as number) & 31];
    if (i % 4 === 3 && i < 15) out += "-";
  }
  return out;
}

/** The code as typed, with case, spaces, and hyphens removed and look-alike letters mapped. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
}

/** The key derived from a code, which is all the hub stores of it. */
export function codeKey(code: string): string {
  return createHash("sha256")
    .update(`aio-enroll-v1:${normalizeCode(code)}`)
    .digest("hex");
}

/** The node's proof that it knows the code and saw `hubFingerprint`. */
export function nodeProof(
  key: string,
  parts: { hubFingerprint: string; nonce: string; name: string; publicKey: string },
): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(
      JSON.stringify(["node", parts.hubFingerprint, parts.nonce, parts.name, parts.publicKey]),
    )
    .digest("hex");
}

/** The hub's proof that it knows the code, over what it returns. */
export function hubProof(
  key: string,
  parts: { nonce: string; machineId: string; clientCert: string; hubCert: string },
): string {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(JSON.stringify(["hub", parts.nonce, parts.machineId, parts.clientCert, parts.hubCert]))
    .digest("hex");
}

/** Compares two hex strings in constant time. */
export function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** One machine row. */
export interface MachineRow {
  id: string;
  name: string;
  role: Machine["role"];
  certFingerprint: string;
  revokedAt: string | null;
  serverVersion: string | null;
  protocol: number | null;
  capabilities: string[];
  platform: Machine["platform"];
  lastSeen: string | null;
  createdAt: string;
}

interface RawMachine {
  id: string;
  name: string;
  role: string;
  cert_fingerprint: string;
  revoked_at: string | null;
  server_version: string | null;
  protocol: number | null;
  capabilities: string;
  platform: string | null;
  last_seen: string | null;
  created_at: string;
}

function toRow(r: RawMachine): MachineRow {
  let capabilities: string[] = [];
  try {
    const parsed = JSON.parse(r.capabilities) as unknown;
    if (Array.isArray(parsed)) capabilities = parsed.filter((c) => typeof c === "string");
  } catch {
    capabilities = [];
  }
  const platform =
    r.platform === "linux" || r.platform === "darwin" || r.platform === "win32" ? r.platform : null;
  const role = r.role === "hub" || r.role === "both" ? r.role : "node";
  return {
    id: r.id,
    name: r.name,
    role,
    certFingerprint: r.cert_fingerprint,
    revokedAt: r.revoked_at,
    serverVersion: r.server_version,
    protocol: r.protocol,
    capabilities,
    platform,
    lastSeen: r.last_seen,
    createdAt: r.created_at,
  };
}

/** The machines table and the enrollment codes table. */
export class MachineRegistry {
  constructor(
    private readonly db: SqlDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): MachineRow[] {
    return (
      this.db.prepare("SELECT * FROM machines ORDER BY created_at, id").all() as RawMachine[]
    ).map(toRow);
  }

  get(id: string): MachineRow | undefined {
    const r = this.db.prepare("SELECT * FROM machines WHERE id = ?").get(id) as
      RawMachine | undefined;
    return r ? toRow(r) : undefined;
  }

  byFingerprint(fingerprint: string): MachineRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM machines WHERE cert_fingerprint = ?")
      .get(fingerprint) as RawMachine | undefined;
    return r ? toRow(r) : undefined;
  }

  /** The machine that holds `name` and isn't revoked. */
  byLiveName(name: string): MachineRow | undefined {
    const r = this.db
      .prepare("SELECT * FROM machines WHERE name = ? COLLATE NOCASE AND revoked_at IS NULL")
      .get(name) as RawMachine | undefined;
    return r ? toRow(r) : undefined;
  }

  /** How many machines are enrolled and not revoked. */
  liveCount(): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM machines WHERE revoked_at IS NULL")
      .get() as { n: number };
    return r.n;
  }

  /** How many machines were ever enrolled, revoked ones included. */
  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM machines").get() as { n: number }).n;
  }

  add(machine: { id: string; name: string; certFingerprint: string }): void {
    const at = this.now().toISOString();
    this.db
      .prepare(
        "INSERT INTO machines (id, name, role, cert_fingerprint, capabilities, created_at, updated_at) VALUES (?, ?, 'node', ?, '[]', ?, ?)",
      )
      .run(machine.id, machine.name, machine.certFingerprint, at, at);
  }

  /** Records what a machine said in its hello, and that it was seen now. */
  seen(
    id: string,
    hello?: {
      role: Machine["role"];
      serverVersion: string;
      protocol: number;
      capabilities: string[];
      platform: Machine["platform"];
    },
  ): void {
    const at = this.now().toISOString();
    if (hello) {
      this.db
        .prepare(
          "UPDATE machines SET role = ?, server_version = ?, protocol = ?, capabilities = ?, platform = ?, last_seen = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          hello.role,
          hello.serverVersion,
          hello.protocol,
          JSON.stringify(hello.capabilities),
          hello.platform,
          at,
          at,
          id,
        );
    } else {
      this.db
        .prepare("UPDATE machines SET last_seen = ?, updated_at = ? WHERE id = ?")
        .run(at, at, id);
    }
  }

  /** Marks a machine revoked. Returns false when it doesn't exist. */
  revoke(id: string): boolean {
    const at = this.now().toISOString();
    const r = this.db
      .prepare(
        "UPDATE machines SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?",
      )
      .run(at, at, id);
    return Number(r.changes) > 0;
  }

  // Enrollment codes

  /** Stores a new code's key; returns the expiry time. */
  addCode(code: string, ttlMs = ENROLLMENT_CODE_TTL_MS): Date {
    const now = this.now();
    const expires = new Date(now.getTime() + ttlMs);
    this.db.prepare("DELETE FROM enrollment_codes WHERE expires_at < ?").run(now.toISOString());
    this.db
      .prepare("INSERT INTO enrollment_codes (code_key, expires_at, created_at) VALUES (?, ?, ?)")
      .run(codeKey(code), expires.toISOString(), now.toISOString());
    return expires;
  }

  /** The keys of the codes that are unused and unexpired. */
  liveCodeKeys(): string[] {
    const rows = this.db
      .prepare("SELECT code_key FROM enrollment_codes WHERE used_at IS NULL AND expires_at > ?")
      .all(this.now().toISOString()) as { code_key: string }[];
    return rows.map((r) => r.code_key);
  }

  /** Marks a code used; returns false when another enrollment used it first. */
  useCode(key: string): boolean {
    const now = this.now().toISOString();
    const r = this.db
      .prepare(
        "UPDATE enrollment_codes SET used_at = ? WHERE code_key = ? AND used_at IS NULL AND expires_at > ?",
      )
      .run(now, key, now);
    return Number(r.changes) > 0;
  }
}
