// Git worktree handling for conversations, ported from the 3.3.5
// `Worktrees.cpp`. Everything shells out to git on the host: worktrees stay
// on disk under the project, visible to the host and surviving the container.
//
// Nothing here deletes anything git has not agreed is safe to delete:
// `removeWorktree()` refuses a worktree with uncommitted work, ignored files
// that exist nowhere else, or commits found on no other branch or remote.
import fs from "node:fs";
import path from "node:path";
import { stamp } from "../records/env.js";
import { git } from "./git.js";

/** Directory under the primary repository that holds the worktrees. */
export const WORKTREES_DIR_NAME = ".worktrees";
/** Branch prefix for each conversation's branch. */
export const BRANCH_PREFIX = "claude/";
/** Directory for per-conversation notes. */
export const NOTES_DIR_NAME = ".claude-box";

/** Whether `dir` is inside a git working tree. */
export async function isRepo(dir: string): Promise<boolean> {
  if (dir === "" || !isDir(dir)) return false;
  return (await git(dir, ["rev-parse", "--is-inside-work-tree"])).ok;
}

/** The repository's top-level working directory, or `""`. */
export async function topLevel(dir: string): Promise<string> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok ? path.posix.normalize(r.output) : "";
}

/** The checked-out branch, or `""` when HEAD is detached. */
export async function currentBranch(dir: string): Promise<string> {
  const r = await git(dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return r.ok ? r.output : "";
}

/** The `origin` remote's URL, or `""`. */
export async function originUrl(dir: string): Promise<string> {
  const r = await git(dir, ["remote", "get-url", "origin"]);
  return r.ok ? r.output : "";
}

/** `<repo>/.worktrees/<slug>`. */
export function worktreePath(repo: string, slug: string): string {
  return path.posix.normalize(`${repo}/${WORKTREES_DIR_NAME}/${slug}`);
}

/** `claude/<slug>`. */
export function branchFor(slug: string): string {
  return BRANCH_PREFIX + slug;
}

/** `<projectRoot>/.claude-box/conversations/<slug>`: a workspace conversation's notes. */
export function notesDir(projectRoot: string, slug: string): string {
  return path.posix.normalize(`${projectRoot}/${NOTES_DIR_NAME}/conversations/${slug}`);
}

/** `<projectRoot>/.claude-box/INFRA.md`: the project's shared notes. */
export function infraFile(projectRoot: string): string {
  return path.posix.normalize(`${projectRoot}/${NOTES_DIR_NAME}/INFRA.md`);
}

/** `<worktree>/.claude-box`: a worktree conversation's notes, ignored by git. */
export function worktreeNotesDir(worktree: string): string {
  return path.posix.normalize(`${worktree}/${NOTES_DIR_NAME}`);
}

/** Creates the worktree's notes directory and returns its path. */
export function ensureWorktreeNotesDir(worktree: string): string {
  const dir = worktreeNotesDir(worktree);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Creates a workspace conversation's notes directory and returns its path. */
export function ensureNotesDir(projectRoot: string, slug: string): string {
  const dir = notesDir(projectRoot, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The `info/exclude` file in the repository's common git directory, or `""`. */
export async function commonExcludeFile(repo: string): Promise<string> {
  const r = await git(repo, ["rev-parse", "--git-common-dir"]);
  if (!r.ok) return "";
  const common = path.isAbsolute(r.output) ? r.output : path.resolve(repo, r.output);
  return path.posix.normalize(`${common}/info/exclude`);
}

function readLines(file: string): string[] {
  try {
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  } catch {
    return [];
  }
}

/**
 * Adds the lines of `fromExcludeFile` (a clone's `.git/info/exclude`) that the
 * repository's own `info/exclude` lacks, so ignored files copied from the
 * clone stay ignored. Returns how many lines were added.
 */
export async function mergeExcludeRules(repo: string, fromExcludeFile: string): Promise<number> {
  const target = await commonExcludeFile(repo);
  if (target === "") return 0;
  const have = readLines(target);
  const add: string[] = [];
  for (const line of readLines(fromExcludeFile)) {
    if (line.trim() === "" || line.startsWith("#") || have.includes(line) || add.includes(line)) {
      continue;
    }
    add.push(line);
  }
  if (add.length === 0) return 0;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, add.map((l) => `${l}\n`).join(""));
  } catch {
    return 0;
  }
  return add.length;
}

/**
 * Adds `.worktrees/` and `.claude-box/` to the repository's `info/exclude`,
 * which lives in the common git directory, so one entry covers every
 * worktree. Idempotent.
 */
export async function ensureExcluded(repo: string): Promise<{ ok: boolean; error?: string }> {
  const r = await git(repo, ["rev-parse", "--git-common-dir"]);
  if (!r.ok) return { ok: false, error: r.output };
  const common = path.isAbsolute(r.output) ? r.output : path.resolve(repo, r.output);
  const file = path.posix.normalize(`${common}/info/exclude`);
  // Git ignores trailing spaces, but a leading space is part of the pattern.
  const have = readLines(file).map((l) => l.replace(/[ \t]+$/, ""));
  const want = [`${WORKTREES_DIR_NAME}/`, `${NOTES_DIR_NAME}/`];
  const missing = want.filter((w) => !have.includes(w) && !have.includes(`/${w}`));
  if (missing.length === 0) return { ok: true };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let prefix = "";
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8");
      if (text.length > 0 && !text.endsWith("\n")) prefix = "\n";
    }
    fs.appendFileSync(file, `${prefix}# claude-box\n${missing.map((m) => `${m}\n`).join("")}`);
  } catch {
    return { ok: false, error: `cannot write ${file}` };
  }
  return { ok: true };
}

/**
 * `git worktree add` for `<repo>/.worktrees/<slug>` on `claude/<slug>`,
 * creating the branch when it does not exist. Reuses a worktree that is
 * already there and refuses a path that exists but is not a worktree.
 */
export async function addWorktree(
  repo: string,
  slug: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const wt = worktreePath(repo, slug);
  const branch = branchFor(slug);
  const ex = await ensureExcluded(repo);
  if (!ex.ok) return { ok: false, error: `could not update info/exclude: ${ex.error ?? ""}` };
  if (fs.existsSync(`${wt}/.git`)) return { ok: true, path: wt };
  if (fs.existsSync(wt)) return { ok: false, error: `${wt} exists but is not a git worktree` };
  const branchExists = (
    await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
  ).ok;
  const args = branchExists
    ? ["worktree", "add", wt, branch]
    : ["worktree", "add", "-b", branch, wt];
  const r = await git(repo, args, { timeoutMs: 120000 });
  if (!r.ok) return { ok: false, error: r.output };
  return { ok: true, path: wt };
}

const BUILD_OUTPUT_NAMES = new Set([
  "node_modules",
  "build",
  "dist",
  "target",
  ".gradle",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  ".next",
  "out",
]);

/**
 * Whether an ignored directory is build output or a dependency cache: large
 * and reproducible, so neither removal nor migration treats it as work.
 */
export function isBuildOutputName(name: string): boolean {
  return BUILD_OUTPUT_NAMES.has(name);
}

/** The last path component of a `git ls-files --directory` entry. */
export function entryLeaf(entry: string): string {
  return path.posix.basename(entry.endsWith("/") ? entry.slice(0, -1) : entry);
}

export type RemoveCheck = { safe: true } | { safe: false; reason: string };

/**
 * Whether a worktree can go without losing work: nothing uncommitted, no
 * ignored file other than build output and the notes folder, and no commit
 * that is not reachable from another branch or a remote.
 */
export async function checkRemovable(_repo: string, wt: string): Promise<RemoveCheck> {
  if (!fs.existsSync(`${wt}/.git`)) return { safe: false, reason: "not a worktree" };

  const st = await git(wt, ["status", "--porcelain", "--ignored=no"]);
  if (!st.ok) return { safe: false, reason: st.output };
  if (st.output !== "") {
    return { safe: false, reason: "it has uncommitted or untracked changes" };
  }

  // `git worktree remove` deletes ignored files too, and those are often the
  // only copy of a .env or a credentials file.
  const ign = await git(
    wt,
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    { trim: false },
  );
  if (!ign.ok) return { safe: false, reason: ign.output };
  const keep = ign.output
    .split("\0")
    .filter((e) => e !== "")
    .filter((e) => {
      const leaf = entryLeaf(e);
      return !isBuildOutputName(leaf) && leaf !== NOTES_DIR_NAME;
    });
  if (keep.length > 0) {
    return {
      safe: false,
      reason: `it has ignored files that exist nowhere else (${keep.slice(0, 3).join(", ")})`,
    };
  }

  // Commits reachable only from here. On a branch, leave that branch out of
  // the comparison; `--exclude` is relative to refs/heads/, not a full ref.
  const branch = await currentBranch(wt);
  const revArgs = ["rev-list", "--count", "HEAD", "--not"];
  if (branch !== "") revArgs.push(`--exclude=${branch}`);
  revArgs.push("--branches", "--remotes");
  const ahead = await git(wt, revArgs);
  if (!ahead.ok) return { safe: false, reason: ahead.output };
  if (Number.parseInt(ahead.output, 10) > 0) {
    return {
      safe: false,
      reason:
        branch === ""
          ? `HEAD is detached and has ${ahead.output} commit(s) that are not on any branch`
          : `branch ${branch} has ${ahead.output} commit(s) that are not on any other branch`,
    };
  }
  return { safe: true };
}

/**
 * Removes a worktree and its `claude/` branch, only when `checkRemovable()`
 * allows it. The notes folder moves to
 * `<repo>/.claude-box/archive/<leaf>-<stamp>` first so removal cannot lose it.
 */
export async function removeWorktree(
  repo: string,
  wt: string,
  now: Date = new Date(),
): Promise<{ ok: true; archive?: string } | { ok: false; reason: string }> {
  const check = await checkRemovable(repo, wt);
  if (!check.safe) return { ok: false, reason: check.reason };

  let archive: string | undefined;
  const notes = worktreeNotesDir(wt);
  if (isDir(notes) && fs.readdirSync(notes).length > 0) {
    archive = path.posix.normalize(
      `${repo}/${NOTES_DIR_NAME}/archive/${path.posix.basename(wt)}-${stamp(now)}`,
    );
    try {
      fs.mkdirSync(path.dirname(archive), { recursive: true });
      fs.renameSync(notes, archive);
    } catch {
      return { ok: false, reason: `could not move the notes in ${notes} to ${archive}` };
    }
  }

  const branch = await currentBranch(wt);
  const r = await git(repo, ["worktree", "remove", wt]);
  if (!r.ok) return { ok: false, reason: r.output };
  // checkRemovable() proved nothing unique is on the branch, so -D is safe.
  if (branch !== "" && branch.startsWith(BRANCH_PREFIX)) {
    await git(repo, ["branch", "-D", branch]);
  }
  return archive === undefined ? { ok: true } : { ok: true, archive };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
