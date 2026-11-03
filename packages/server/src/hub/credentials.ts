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
// A file counts as synced only after it reaches the other end, or after this
// end wrote it from the other end. Those hashes stay on disk, so a change made
// while the server was stopped is still a change. A local change that hasn't
// synced is the only copy of a rotated token, so copying from the hub leaves
// it in place; only a live update from the hub replaces it, as the last change.
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

/** The file that holds the synced hashes, inside the data directory. */
const SYNC_STATE_FILE = "credential-sync.json";

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

/** True for what a sign-in file holds: a JSON object with at least one field. */
function isSignIn(bytes: Buffer): boolean {
  try {
    const value: unknown = JSON.parse(bytes.toString());
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
    );
  } catch {
    return false;
  }
}

/**
 * The bytes of an entry from the other end, or `null` when they aren't strict
 * base64, don't match the sender's hash, or aren't a sign-in file.
 */
export function entryBytes(entry: CredentialEntry): Buffer | null {
  const bytes = Buffer.from(entry.content, "base64");
  if (bytes.toString("base64") !== entry.content) return null;
  if (sha(bytes) !== entry.sha256) return null;
  return isSignIn(bytes) ? bytes : null;
}

export interface CredentialStoreOptions {
  home: string;
  dataDir: string;
  /** Reports a failure to save the synced hashes. Default: no report. */
  log?: (message: string) => void;
}

/** The synced files on one machine, and the version of each it last synced. */
export class CredentialStore {
  /** The hash of each file as it last synced, or as `prime` first found it. */
  private readonly known = new Map<string, string>();
  /** Runs reads that compare with `known` and writes one at a time. */
  private lock: Promise<unknown> = Promise.resolve();
  private loaded = false;

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

  private locked<T>(run: () => Promise<T>): Promise<T> {
    const result = this.lock.then(run, run);
    this.lock = result.catch(() => undefined);
    return result;
  }

  private get stateFile(): string {
    return path.join(this.opts.dataDir, SYNC_STATE_FILE);
  }

  /** Reads the saved hashes once. A missing or damaged file holds none. */
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const saved: unknown = JSON.parse(await fs.readFile(this.stateFile, "utf8"));
      for (const [key, hash] of Object.entries(saved as Record<string, unknown>)) {
        if (isCredentialKey(key) && typeof hash === "string") this.known.set(key, hash);
      }
    } catch {
      // The next `prime` starts again from the files on disk.
    }
  }

  /** Saves the hashes. A failure costs only the change detection after a restart. */
  private async save(): Promise<void> {
    try {
      await fs.mkdir(this.opts.dataDir, { recursive: true });
      await writeAtomic(this.stateFile, JSON.stringify(Object.fromEntries(this.known)), 0o600);
    } catch (err) {
      this.opts.log?.(`Couldn't save the sign-in sync state: ${(err as Error).message}`);
    }
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

  /** One synced file as it is now, or `null` when it's missing or not a sign-in file. */
  async entry(key: string): Promise<CredentialEntry | null> {
    const bytes = await this.read(key);
    if (!bytes || !isSignIn(bytes)) return null;
    return { key, content: bytes.toString("base64"), sha256: sha(bytes) };
  }

  /** Every synced file that exists here. Listing a file doesn't sync it. */
  async list(): Promise<CredentialEntry[]> {
    const out: CredentialEntry[] = [];
    for (const key of await this.candidateKeys()) {
      const entry = await this.entry(key);
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * Loads the saved hashes and treats a file with none as synced, so that a
   * machine's first check doesn't send what it already had. A saved hash stays,
   * so a change made while the server was stopped still counts. With `reset`,
   * every file counts as synced, for a machine that is about to join a hub.
   */
  prime(options: { reset?: boolean } = {}): Promise<void> {
    return this.locked(async () => {
      await this.load();
      for (const key of await this.candidateKeys()) {
        const bytes = await this.read(key);
        if (bytes && (options.reset || !this.known.has(key))) this.known.set(key, sha(bytes));
      }
      await this.save();
    });
  }

  /**
   * The files that differ from what last synced. A file stays in this list
   * until `markSynced`, so a failed send is sent again. A half-written file
   * waits for the next check.
   */
  changes(): Promise<CredentialEntry[]> {
    return this.locked(async () => {
      await this.load();
      const out: CredentialEntry[] = [];
      for (const key of await this.candidateKeys()) {
        const entry = await this.entry(key);
        if (entry && this.known.get(key) !== entry.sha256) out.push(entry);
      }
      return out;
    });
  }

  /** Records that the other end has the file with this hash. */
  markSynced(key: string, hash: string): Promise<void> {
    return this.locked(async () => {
      await this.load();
      this.known.set(key, hash);
      await this.save();
    });
  }

  /**
   * Writes a synced file with mode 0600, when its folder exists and its
   * content differs. Returns whether it wrote. Throws for a key the sync
   * doesn't allow, for content that `entryBytes` refuses, and when the write
   * fails, which leaves the file and its synced hash as they were. With
   * `keepLocalChange`, a file that changed here since it last synced stays.
   */
  write(entry: CredentialEntry, options: { keepLocalChange?: boolean } = {}): Promise<boolean> {
    return this.locked(async () => {
      await this.load();
      const file = this.pathFor(entry.key);
      if (!file) throw new Error(`The sync doesn't write ${entry.key}.`);
      const bytes = entryBytes(entry);
      if (!bytes) throw new Error(`The content for ${entry.key} isn't a valid sign-in file.`);
      try {
        if (!(await fs.stat(path.dirname(file))).isDirectory()) return false;
      } catch {
        return false;
      }
      const current = await this.read(entry.key);
      const currentHash = current && sha(current);
      if (currentHash !== entry.sha256) {
        if (options.keepLocalChange && currentHash && currentHash !== this.known.get(entry.key)) {
          return false;
        }
        // The rename replaces a link in the file's place rather than following it.
        await writeAtomic(file, bytes, 0o600);
      }
      if (this.known.get(entry.key) !== entry.sha256) {
        this.known.set(entry.key, entry.sha256);
        await this.save();
      }
      return currentHash !== entry.sha256;
    });
  }
}
