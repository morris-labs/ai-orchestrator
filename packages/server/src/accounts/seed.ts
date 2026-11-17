// Seeding: copies a host agent folder into a new account folder, and
// never moves it: seeding copies.
//
// The copy treats every file as opaque bytes: it never opens a file to read
// its content, except `config.toml` for Codex, which holds settings, not a
// sign-in, and Claude's `.claude.json`, which can hold the `/login` API key.
// Seeding copies only explicit sign-in files unless setup copying is requested.
// Setup links become real copies, so an account is independent afterward.
import { constants as fsc } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Platform } from "@aio/contracts";

/** Claude Code's sign-in, relative to its config folder. */
export const CLAUDE_SIGN_IN_FILES = [".credentials.json"] as const;

/** Codex's sign-in, relative to `CODEX_HOME`. */
export const CODEX_SIGN_IN_FILES = ["auth.json"] as const;

/**
 * Copilot's sign-in, relative to `COPILOT_HOME`. Phase 0 (check 5) found that
 * without a keychain Copilot stores the token in plain text in `config.json`
 * under `authTokens`, next to settings. Seeding copies the file whole.
 * The other names cover older sign-in formats.
 */
export const COPILOT_SIGN_IN_FILES = [
  "config.json",
  "hosts.yml",
  "credentials.toml",
  "registered.tokens.json",
] as const;

/** Explicit sign-in files seeding copies, per vendor, relative to the folder. */
export const SIGN_IN_FILES: Record<Platform, readonly string[]> = {
  claude: CLAUDE_SIGN_IN_FILES,
  codex: CODEX_SIGN_IN_FILES,
  copilot: COPILOT_SIGN_IN_FILES,
};

/**
 * Files that hold a token, matched by base name at any depth: `agent.env`
 * (the maintainer's GitHub token sits in `~/.claude`), any `.env` or `*.env`
 * file, the sign-in file names of every vendor, and `.claude.json` backups,
 * which can hold the /login API key.
 */
const DENIED_BASE_NAMES = new Set([
  ".credentials.json",
  "auth.json",
  "agent.env",
  ".env",
  "hosts.yml",
  "credentials.toml",
  "registered.tokens.json",
]);

/** Whether seeding leaves out a file of this base name, at any depth. */
export function isDeniedName(name: string): boolean {
  return (
    DENIED_BASE_NAMES.has(name) || name.endsWith(".env") || name.startsWith(".claude.json.backup")
  );
}

/** The `installMethod` of the image's Claude Code, which installs with `npm install -g`. */
export const CLAUDE_INSTALL_METHOD = "global";

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
  /** Leaves out every file whose base name `isDeniedName` matches. Default: true. */
  denyNames?: boolean;
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
  const denyNames = options.denyNames ?? true;
  const root = await fs.realpath(source);

  async function walk(src: string, dst: string, rel: string): Promise<void> {
    const st = rel === "" ? await fs.stat(src) : await fs.lstat(src);
    if (rel !== "" && (leaveOut.has(rel) || (denyNames && isDeniedName(path.basename(rel))))) {
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

/** Copies only the host sign-in, with an optional one-time Claude setup copy.
 * Links are followed into independent files; dangling links and cycles are reported.
 */
export async function seedFolder(
  vendor: Platform,
  sources: SeedSources,
  dest: string,
  options: { dryRun?: boolean; copyHostSetup?: boolean } = {},
): Promise<SeedFolderResult> {
  const source = sourceDirOf(sources, vendor);
  // Resolve the source up front, including for dry runs and missing folders.
  await fs.realpath(source);
  const stats = emptyStats();
  const notes: string[] = [];
  const temp = `${dest}.seeding-${process.pid}-${Date.now()}`;
  async function copy(
    src: string,
    target: string,
    rel: string,
    ancestors: ReadonlySet<string>,
  ): Promise<void> {
    let real: string;
    try {
      real = await fs.realpath(src);
    } catch (err) {
      if (["ENOENT", "ELOOP"].includes((err as NodeJS.ErrnoException).code ?? "")) {
        notes.push(`Skipped missing or cyclic source: ${rel}.`);
        return;
      }
      throw err;
    }
    if (ancestors.has(real)) {
      notes.push(`Skipped cycle: ${rel}.`);
      return;
    }
    const st = await fs.stat(real);
    if (st.isDirectory()) {
      if (!options.dryRun) await fs.mkdir(target, { mode: 0o700 });
      const next = new Set([...ancestors, real]);
      for (const name of (await fs.readdir(real)).sort())
        await copy(path.join(real, name), path.join(target, name), `${rel}/${name}`, next);
    } else if (st.isFile()) {
      stats.files++;
      stats.bytes += st.size;
      if (!options.dryRun) {
        await fs.copyFile(real, target, fsc.COPYFILE_EXCL | fsc.COPYFILE_FICLONE);
        await fs.chmod(target, st.mode & 0o777);
      }
    } else {
      stats.skippedSpecial.push(rel);
    }
  }
  try {
    if (!options.dryRun) {
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fs.mkdir(temp, { mode: 0o700 });
    }
    const entries = [...SIGN_IN_FILES[vendor]] as string[];
    if (vendor === "claude" && options.copyHostSetup)
      entries.push("CLAUDE.md", "settings.json", "skills", "plugins");
    for (const name of entries) {
      const src = path.join(source, name);
      if (await exists(src)) await copy(src, path.join(temp, name), name, new Set());
    }
    if (vendor === "claude" && (await exists(sources.claudeJson))) {
      await copy(sources.claudeJson, path.join(temp, ".claude.json"), ".claude.json", new Set());
      if (!options.dryRun)
        await setInstallMethod(path.join(temp, ".claude.json"), CLAUDE_INSTALL_METHOD);
    }
    if (vendor === "codex" && !options.dryRun)
      await addCodexFileStore(path.join(temp, "config.toml"));
    if (!options.dryRun) await fs.rename(temp, dest);
    return { ...stats, notes };
  } catch (err) {
    if (!options.dryRun) await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Sets `installMethod` in a copied `.claude.json`, so that Claude Code in the
 * image doesn't warn that `~/.local/bin/claude` is missing (the host records
 * a native install). Returns whether it changed the file. Leaves a file that
 * isn't a JSON object alone. Never logs the content.
 */
export async function setInstallMethod(claudeJson: string, method: string): Promise<boolean> {
  let config: unknown;
  try {
    config = JSON.parse(await fs.readFile(claudeJson, "utf8"));
  } catch {
    return false;
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) return false;
  const obj = config as Record<string, unknown>;
  if (obj.installMethod === method) return false;
  obj.installMethod = method;
  await fs.writeFile(claudeJson, `${JSON.stringify(obj, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(claudeJson, 0o600);
  return true;
}

/**
 * Puts `cli_auth_credentials_store = "file"` at the top of a Codex
 * `config.toml` that sets no store, or creates the file with it. A TOML key
 * after a `[table]` header belongs to that table, so the line goes first.
 * Returns whether it changed the file.
 *
 * A `config.toml` that is a symbolic link, as dotfile managers make it, is
 * read through and replaced by a regular file, so the write never reaches
 * the file the link points at.
 */
export async function addCodexFileStore(configToml: string): Promise<boolean> {
  let text = "";
  try {
    text = await fs.readFile(configToml, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (/^\s*cli_auth_credentials_store\s*=/m.test(text)) return false;
  const isLink = await fs.lstat(configToml).then(
    (s) => s.isSymbolicLink(),
    () => false,
  );
  if (isLink) await fs.unlink(configToml);
  // `wx` refuses to write through a link that appears in between.
  await fs.writeFile(configToml, `${CODEX_STORE_SETTING}\n${text}`, {
    mode: 0o600,
    flag: isLink ? "wx" : "w",
  });
  return true;
}
