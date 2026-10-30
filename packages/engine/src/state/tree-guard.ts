// Checks that read-only agent calls leave the worktree alone. A vendor CLI
// that runs without its own sandbox (Codex with `danger-full-access`, since
// the container is the sandbox) could edit the repository during a review
// or a disprover call. The guard takes a snapshot of the worktree before the
// first of a set of overlapping read-only calls and compares each call's end
// against it.
//
// The guard never deletes or resets anything itself. It can't tell an
// agent's change from one that a person or another process made during the
// call, so it restores a worktree only through the `restore` callback, which
// the engine passes only for a checkout it owns (see `checkout.ts`).
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { CommandRunner } from "../core.js";

/** The state of a worktree that a read-only call must not change. */
export interface TreeSnapshot {
  /** `HEAD`'s commit, or an empty string in a repository with no commits. */
  head: string;
  /** The checked-out branch, or an empty string for a detached `HEAD`. */
  branch: string;
  /** `git status --porcelain` entries, sorted, without the ignored paths. */
  status: string[];
  /** A hash of the tracked changes against `HEAD` and of every untracked file's content. */
  digest: string;
}

/** Thrown when a read-only call changed the worktree. */
export class ReadOnlyViolation extends Error {
  constructor(
    message: string,
    readonly restored: boolean,
  ) {
    super(message);
    this.name = "ReadOnlyViolation";
  }
}

export interface TreeGuardOptions {
  runner: CommandRunner;
  /** The worktree the calls must leave alone. */
  repoPath: string;
  /**
   * Directories the calls may write, such as the run directory with its
   * scratch directories. Changes under them don't count.
   */
  ignore: readonly string[];
  /**
   * Puts the worktree back the way it was before the calls; resolves to
   * whether it did. Pass it only for a worktree that holds nothing but the
   * engine's own files. Absent, the guard reports a change and leaves the
   * worktree as it is.
   */
  restore?: () => Promise<boolean>;
}

/**
 * Takes a snapshot of the worktree: `HEAD`, the branch, the status, and a
 * hash of the tracked changes and of the untracked files' contents. Files
 * git ignores don't count.
 */
export async function snapshotTree(
  runner: CommandRunner,
  repoPath: string,
  ignore: readonly string[] = [],
): Promise<TreeSnapshot> {
  const git = async (args: string[], allowFailure = false): Promise<string> => {
    const r = await runner.run("git", args, { cwd: repoPath, timeoutMs: 60_000 });
    if (r.exitCode !== 0) {
      if (allowFailure) return "";
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
    }
    return r.stdout;
  };
  const head = (await git(["rev-parse", "--verify", "-q", "HEAD"], true)).trim();
  const branch = (await git(["symbolic-ref", "-q", "--short", "HEAD"], true)).trim();
  const prefixes = ignorePrefixes(repoPath, ignore);
  const kept = (path: string) =>
    !prefixes.some((p) => path === p.slice(0, -1) || path.startsWith(p));
  const entries = parsePorcelainZ(
    await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ).filter((e) => kept(e.path));
  const hash = createHash("sha256");
  if (head) {
    const paths = entries.filter((e) => e.code !== "??").map((e) => e.path);
    if (paths.length > 0) hash.update(await git(["diff", "--binary", "HEAD", "--", ...paths]));
  }
  for (const e of entries.filter((x) => x.code === "??").sort((a, b) => cmp(a.path, b.path))) {
    hash.update(`\0${e.path}\0`);
    hash.update(await fileDigest(join(repoPath, e.path)));
  }
  return {
    head,
    branch,
    status: entries.map((e) => `${e.code} ${e.path}`).sort(cmp),
    digest: hash.digest("hex"),
  };
}

/** What changed between two snapshots, in one line, or `null` when nothing did. */
export function describeTreeChange(before: TreeSnapshot, after: TreeSnapshot): string | null {
  const parts: string[] = [];
  if (before.head !== after.head)
    parts.push(`HEAD moved from ${short(before.head)} to ${short(after.head)}`);
  if (before.branch !== after.branch)
    parts.push(
      `the branch changed from ${before.branch || "(detached)"} to ${after.branch || "(detached)"}`,
    );
  const was = new Set(before.status);
  const now = new Set(after.status);
  const added = after.status.filter((s) => !was.has(s));
  const gone = before.status.filter((s) => !now.has(s));
  const files = [...added, ...gone].map((s) => s.slice(3));
  if (files.length > 0) {
    const shown = [...new Set(files)].slice(0, 5).join(", ");
    parts.push(`files changed: ${shown}${files.length > 5 ? ", ..." : ""}`);
  } else if (before.digest !== after.digest) {
    parts.push("the content of changed or untracked files differs");
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * Guards a set of read-only calls on one worktree. Calls can overlap: the
 * first one in takes the baseline, and each call's end is compared against
 * it, so a change by one call fails every call that ends before the tree is
 * restored. The engine retries a failed call once.
 */
export class TreeGuard {
  private active = 0;
  private baseline: Promise<TreeSnapshot> | null = null;

  constructor(private readonly opts: TreeGuardOptions) {}

  /**
   * Runs `call`, then checks the worktree. Throws `ReadOnlyViolation` when
   * the call succeeded but changed the worktree. A call that failed keeps
   * its own error; the guard still restores the tree behind it.
   */
  async run<T>(call: () => Promise<T>, onFailedCallChange?: (message: string) => void): Promise<T> {
    if (this.active === 0 || !this.baseline) {
      this.baseline = snapshotTree(this.opts.runner, this.opts.repoPath, this.opts.ignore);
    }
    this.active += 1;
    try {
      // The call starts only once the baseline is taken.
      const baseline = await this.baseline;
      let result: T;
      try {
        result = await call();
      } catch (error) {
        await this.check(baseline).catch((e: unknown) => {
          onFailedCallChange?.((e as Error).message);
        });
        throw error;
      }
      await this.check(baseline);
      return result;
    } finally {
      this.active -= 1;
      if (this.active === 0) this.baseline = null;
    }
  }

  /** Compares the worktree with `baseline`; restores it when it may, and throws when they differ. */
  private async check(baseline: TreeSnapshot): Promise<void> {
    const { runner, repoPath, ignore } = this.opts;
    const after = await snapshotTree(runner, repoPath, ignore);
    const change = describeTreeChange(baseline, after);
    if (!change) return;
    const restored = await this.restore(baseline);
    throw new ReadOnlyViolation(
      `A read-only call changed the worktree ${repoPath}: ${change}. ` +
        (restored
          ? "The engine restored its checkout and treats the call as failed."
          : this.opts.restore
            ? "The engine couldn't restore its checkout. The call counts as failed."
            : "The engine doesn't own this worktree, so it changed nothing; the change might be a person's or another process's. Check it by hand. The call counts as failed."),
      restored,
    );
  }

  /** Runs the `restore` callback and checks the result against `baseline`. */
  private async restore(baseline: TreeSnapshot): Promise<boolean> {
    const { runner, repoPath, ignore, restore } = this.opts;
    if (!restore) return false;
    if (!(await restore().catch(() => false))) return false;
    const final = await snapshotTree(runner, repoPath, ignore);
    return describeTreeChange(baseline, final) === null;
  }
}

interface PorcelainEntry {
  code: string;
  path: string;
}

/** Parses `git status --porcelain=v1 -z`. A rename's entry is followed by its source path. */
export function parsePorcelainZ(text: string): PorcelainEntry[] {
  const out: PorcelainEntry[] = [];
  const parts = text.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (part.length < 4) continue;
    const code = part.slice(0, 2);
    out.push({ code, path: part.slice(3) });
    if (code.includes("R") || code.includes("C")) {
      // The source path; it changed as well.
      const from = parts[i + 1];
      if (from) out.push({ code, path: from });
      i += 1;
    }
  }
  return out;
}

/** Repository-relative prefixes, each ending in `/`, for the ignored directories inside the repository. */
function ignorePrefixes(repoPath: string, ignore: readonly string[]): string[] {
  const out: string[] = [];
  for (const dir of ignore) {
    const rel = relative(repoPath, dir);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    out.push(`${rel.split(sep).join("/")}/`);
  }
  return out;
}

async function fileDigest(path: string): Promise<string> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return `link:${await readlink(path)}`;
    if (!st.isFile()) return `other:${st.mode}`;
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return "missing";
  }
}

function short(sha: string): string {
  return sha ? sha.slice(0, 12) : "(none)";
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
