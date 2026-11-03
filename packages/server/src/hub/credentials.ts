// Agent sign-in sync. The hub is the source of truth for the agent CLIs'
// sign-in files; a node copies them from the hub when its link comes up.
// An agent CLI that refreshes its OAuth token rewrites its file, and might
// rotate the refresh token, which would sign out every other copy. So each
// end checks its files on a timer: a node sends a changed file to the hub,
// and the hub writes it and sends it to every other node. The last change
// wins.
//
// A node is less trusted than the hub, so the hub copies a file to a machine
// only when that machine's grant lists the key in `signInCopies`, and takes a
// file from it only when the grant lists the key in `signInUpdates`.
//
// Synced files, by key:
//
//   host/claude/.credentials.json  HOME/.claude/.credentials.json
//   host/codex/auth.json           HOME/.codex/auth.json
//   account/VENDOR/NAME/FILE       DATA_DIR/accounts/VENDOR/NAME/FILE, for
//                                  Claude's .credentials.json and Codex's
//                                  auth.json
//
// GitHub Copilot keeps its token in `config.json` beside its settings, so
// it isn't synced. A file is written only where its folder already exists:
// an account must exist on a node for its sign-in to arrive there. Contents
// are opaque bytes that never reach a log line.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomic } from "./ca.js";

/** The link paths of the sync. */
export const CREDENTIAL_PATHS = {
  /** Node to hub: every synced file the hub has. */
  pull: "/link/v1/credentials/pull",
  /** Node to hub: a file the node's agent CLI changed. */
  push: "/link/v1/credentials/push",
  /** Hub to node: a file to write. */
  update: "/link/v1/credentials/update",
} as const;

/** One synced file. */
export interface CredentialEntry {
  key: string;
  /** The content, base64. */
  content: string;
  sha256: string;
}

const KEY_PATTERN =
  /^(host\/claude\/\.credentials\.json|host\/codex\/auth\.json|account\/claude\/[a-z0-9][a-z0-9-]{0,62}\/\.credentials\.json|account\/codex\/[a-z0-9][a-z0-9-]{0,62}\/auth\.json)$/;

/** True when `key` names a file the sync may read or write. */
export function isCredentialKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface CredentialStoreOptions {
  home: string;
  dataDir: string;
}

/** The synced files on one machine, and the version of each it last synced. */
export class CredentialStore {
  /** The hash of each file as this end last read or wrote it. */
  private readonly known = new Map<string, string>();

  constructor(private readonly opts: CredentialStoreOptions) {}

  /** The file for `key`, or `null` for a key the sync doesn't allow. */
  pathFor(key: string): string | null {
    if (!isCredentialKey(key)) return null;
    const parts = key.split("/");
    if (parts[0] === "host") {
      return path.join(this.opts.home, parts[1] === "claude" ? ".claude" : ".codex", parts[2]!);
    }
    return path.join(this.opts.dataDir, "accounts", parts[1]!, parts[2]!, parts[3]!);
  }

  /** The keys of the files that could exist here. */
  private async candidateKeys(): Promise<string[]> {
    const keys = ["host/claude/.credentials.json", "host/codex/auth.json"];
    for (const [vendor, file] of [
      ["claude", ".credentials.json"],
      ["codex", "auth.json"],
    ] as const) {
      const names = await fs
        .readdir(path.join(this.opts.dataDir, "accounts", vendor))
        .catch(() => [] as string[]);
      for (const name of names) {
        const key = `account/${vendor}/${name}/${file}`;
        if (isCredentialKey(key)) keys.push(key);
      }
    }
    return keys;
  }

  private async read(key: string): Promise<Buffer | null> {
    const file = this.pathFor(key);
    if (!file) return null;
    try {
      const stat = await fs.lstat(file);
      // A link could lead out of the folder, so only regular files count.
      if (!stat.isFile()) return null;
      return await fs.readFile(file);
    } catch {
      return null;
    }
  }

  /** Every synced file that exists here, and marks each as known. */
  async list(): Promise<CredentialEntry[]> {
    const out: CredentialEntry[] = [];
    for (const key of await this.candidateKeys()) {
      const bytes = await this.read(key);
      if (!bytes) continue;
      const hash = sha(bytes);
      this.known.set(key, hash);
      out.push({ key, content: bytes.toString("base64"), sha256: hash });
    }
    return out;
  }

  /** Marks every existing file as known, so the first check sends nothing. */
  async prime(): Promise<void> {
    await this.list();
  }

  /** The files that changed since this end last read or wrote them. */
  async changes(): Promise<CredentialEntry[]> {
    const out: CredentialEntry[] = [];
    for (const key of await this.candidateKeys()) {
      const bytes = await this.read(key);
      if (!bytes) continue;
      const hash = sha(bytes);
      if (this.known.get(key) === hash) continue;
      this.known.set(key, hash);
      out.push({ key, content: bytes.toString("base64"), sha256: hash });
    }
    return out;
  }

  /**
   * Writes a synced file with mode 0600, when its folder exists and its
   * content differs. Returns whether it wrote. Throws for a key the sync
   * doesn't allow.
   */
  async write(entry: { key: string; content: string }): Promise<boolean> {
    const file = this.pathFor(entry.key);
    if (!file) throw new Error(`The sync doesn't write ${entry.key}.`);
    const bytes = Buffer.from(entry.content, "base64");
    const hash = sha(bytes);
    try {
      if (!(await fs.stat(path.dirname(file))).isDirectory()) return false;
    } catch {
      return false;
    }
    const current = await this.read(entry.key);
    this.known.set(entry.key, hash);
    if (current && sha(current) === hash) return false;
    // The rename replaces a link in the file's place rather than following it.
    await writeAtomic(file, bytes, 0o600);
    return true;
  }
}
