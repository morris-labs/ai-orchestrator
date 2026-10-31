// Seeding: copies a host agent folder into a new account folder, as owner
// decision 2 of `docs/v4/design-accounts.md` chose (copy, never move).
//
// The copy treats every file as opaque bytes: it never opens a file to read
// its content, except `config.toml` for Codex, which holds settings, not a
// sign-in. Symbolic links stay links and are never followed. Sign-in files
// are left out by name, so each account signs in on its own and no two
// folders hold one refresh token.
import { constants as fsc } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Platform } from "@agentbox/contracts";

/** Claude Code's sign-in, relative to its config folder. */
export const CLAUDE_SIGN_IN_FILES = [".credentials.json"] as const;

/** Codex's sign-in, relative to `CODEX_HOME`. */
export const CODEX_SIGN_IN_FILES = ["auth.json"] as const;

/**
 * Files that might hold Copilot's stored sign-in, relative to `COPILOT_HOME`.
 * UNVERIFIED: Copilot keeps its token in the system keychain and falls back
 * to a plaintext file when `storeTokenPlaintext` allows it. The installed CLI
 * (1.0.105) handles the token in native code, so the names below come from
 * strings in that code, not from a confirmed sign-in. Phase 0 of the design
 * (`docs/v4/host-accounts-phase0.md`, check 5) confirms the real names;
 * replace this list then.
 */
export const COPILOT_SIGN_IN_FILES_UNVERIFIED = [
  "hosts.yml",
  "credentials.toml",
  "registered.tokens.json",
] as const;

/** The sign-in files seeding leaves out, per vendor, relative to the folder. */
export const SIGN_IN_FILES: Record<Platform, readonly string[]> = {
  claude: CLAUDE_SIGN_IN_FILES,
  codex: CODEX_SIGN_IN_FILES,
  copilot: COPILOT_SIGN_IN_FILES_UNVERIFIED,
};

/** The Codex setting that keeps its sign-in in a file, which a container needs. */
export const CODEX_STORE_SETTING = 'cli_auth_credentials_store = "file"';

export interface CopyStats {
  files: number;
  bytes: number;
  symlinks: number;
  /** Paths left out, relative to the source, with `/` separators. */
  leftOut: string[];
  /** Sockets, pipes, and devices, relative to the source. */
  skippedSpecial: string[];
}

export interface CopyOptions {
  /** Relative paths (with `/`) to leave out. */
  leaveOut?: ReadonlySet<string>;
  /** Counts what a copy would hold and writes nothing. */
  dryRun?: boolean;
}

function emptyStats(): CopyStats {
  return { files: 0, bytes: 0, symlinks: 0, leftOut: [], skippedSpecial: [] };
}

/**
 * The target to give a copied link. A relative target that stays inside the
 * copied tree stays relative, so it points at the copy's own entry. One that
 * leaves the tree becomes absolute, so it still points where it did, such as
 * a `projects` link to a shared transcript store.
 */
export function linkTargetForCopy(sourceRoot: string, linkPath: string, target: string): string {
  if (path.isAbsolute(target)) return target;
  const resolved = path.resolve(path.dirname(linkPath), target);
  const rel = path.relative(sourceRoot, resolved);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  return inside ? target : resolved;
}

/**
 * Copies the tree at `source` to `dest`, which must not exist, like
 * `cp -a`: modes and times kept, links copied as links, sockets, pipes, and
 * devices skipped. A `source` that is itself a link is followed, since it
 * names the folder to copy.
 */
export async function copyTree(
  source: string,
  dest: string,
  options: CopyOptions = {},
): Promise<CopyStats> {
  const stats = emptyStats();
  const leaveOut = options.leaveOut ?? new Set<string>();
  const root = await fs.realpath(source);

  async function walk(src: string, dst: string, rel: string): Promise<void> {
    const st = rel === "" ? await fs.stat(src) : await fs.lstat(src);
    if (rel !== "" && leaveOut.has(rel)) {
      stats.leftOut.push(rel);
      return;
    }
    if (st.isSymbolicLink()) {
      stats.symlinks += 1;
      if (options.dryRun) return;
      const target = await fs.readlink(src);
      await fs.symlink(linkTargetForCopy(root, path.join(root, rel), target), dst);
      return;
    }
    if (st.isDirectory()) {
      if (!options.dryRun) await fs.mkdir(dst, { mode: 0o700 });
      const entries = (await fs.readdir(src)).sort();
      for (const name of entries) {
        await walk(
          path.join(src, name),
          path.join(dst, name),
          rel === "" ? name : `${rel}/${name}`,
        );
      }
      if (!options.dryRun) {
        await fs.chmod(dst, st.mode & 0o7777);
        await fs.utimes(dst, st.atime, st.mtime);
      }
      return;
    }
    if (st.isFile()) {
      stats.files += 1;
      stats.bytes += st.size;
      if (options.dryRun) return;
      await fs.copyFile(src, dst, fsc.COPYFILE_EXCL | fsc.COPYFILE_FICLONE);
      await fs.chmod(dst, st.mode & 0o7777);
      await fs.utimes(dst, st.atime, st.mtime);
      return;
    }
    stats.skippedSpecial.push(rel);
  }

  await walk(root, dest, "");
  return stats;
}

/** The host paths seeding reads, passed explicitly so tests never touch a real home. */
export interface SeedSources {
  /** `~/.claude`. */
  claudeDir: string;
  /** `~/.claude.json`, which replaces the copy's stale `.claude.json`. */
  claudeJson: string;
  /** `~/.codex`. */
  codexDir: string;
  /** `~/.copilot`. */
  copilotDir: string;
}

/** The host folder each vendor's account copies. */
export function sourceDirOf(sources: SeedSources, vendor: Platform): string {
  if (vendor === "claude") return sources.claudeDir;
  if (vendor === "codex") return sources.codexDir;
  return sources.copilotDir;
}

export interface SeedFolderResult extends CopyStats {
  /** Notes for a person to read, such as a link that replaced a directory. */
  notes: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function isRealDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Builds one vendor's account folder at `dest` from the host folder. It
 * copies into a sibling temporary folder and renames it into place at the
 * end, so a failure leaves no half-made account folder behind.
 *
 * - Claude: leaves out `.credentials.json`, copies `~/.claude.json` over the
 *   copy's own (stale) `.claude.json`, or drops the stale one when the host
 *   has none. A `projects` that is a plain directory isn't copied: the
 *   account gets a link to it, so the host and every Claude account share
 *   one transcript store (owner decision 1).
 * - Codex: leaves out `auth.json`, and adds
 *   `cli_auth_credentials_store = "file"` when `config.toml` sets no store,
 *   because a container has no keyring.
 * - Copilot: leaves out `COPILOT_SIGN_IN_FILES_UNVERIFIED`.
 */
export async function seedFolder(
  vendor: Platform,
  sources: SeedSources,
  dest: string,
  options: { dryRun?: boolean } = {},
): Promise<SeedFolderResult> {
  const source = sourceDirOf(sources, vendor);
  const leaveOut = new Set(SIGN_IN_FILES[vendor]);
  const notes: string[] = [];
  const projects = path.join(source, "projects");
  const linkProjects = vendor === "claude" && (await isRealDirectory(projects));
  if (linkProjects) leaveOut.add("projects");

  if (options.dryRun) {
    const stats = await copyTree(source, dest, { leaveOut, dryRun: true });
    if (linkProjects) {
      stats.leftOut = stats.leftOut.filter((p) => p !== "projects");
      notes.push(`projects would link to ${projects}; transcripts aren't copied.`);
    }
    return { ...stats, notes };
  }

  await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  const temp = `${dest}.seeding-${process.pid}-${Date.now()}`;
  try {
    const stats = await copyTree(source, temp, { leaveOut });
    if (vendor === "claude") {
      const stale = path.join(temp, ".claude.json");
      await fs.rm(stale, { force: true });
      if (await exists(sources.claudeJson)) {
        await fs.copyFile(sources.claudeJson, stale, fsc.COPYFILE_FICLONE);
        await fs.chmod(stale, 0o600);
      } else {
        notes.push(`${sources.claudeJson} doesn't exist; Claude Code creates a new .claude.json.`);
      }
      if (linkProjects) {
        stats.leftOut = stats.leftOut.filter((p) => p !== "projects");
        await fs.symlink(projects, path.join(temp, "projects"));
        stats.symlinks += 1;
        notes.push(`projects links to ${projects}; transcripts aren't copied.`);
      }
    }
    if (vendor === "codex") {
      if (await addCodexFileStore(path.join(temp, "config.toml"))) {
        notes.push(`Added ${CODEX_STORE_SETTING} to config.toml.`);
      }
    }
    // The account folder holds a sign-in once someone signs in: owner only.
    await fs.chmod(temp, 0o700);
    await fs.rename(temp, dest);
    return { ...stats, notes };
  } catch (err) {
    await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Puts `cli_auth_credentials_store = "file"` at the top of a Codex
 * `config.toml` that sets no store, or creates the file with it. A TOML key
 * after a `[table]` header belongs to that table, so the line goes first.
 * Returns whether it changed the file.
 */
export async function addCodexFileStore(configToml: string): Promise<boolean> {
  let text = "";
  try {
    text = await fs.readFile(configToml, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (/^\s*cli_auth_credentials_store\s*=/m.test(text)) return false;
  await fs.writeFile(configToml, `${CODEX_STORE_SETTING}\n${text}`, { mode: 0o600 });
  return true;
}
