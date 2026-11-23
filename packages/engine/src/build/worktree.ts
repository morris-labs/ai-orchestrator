// The build worktree: one Git worktree under the repository's `.worktrees/`
// directory, on the build branch. Every agent and the task gate work there,
// so the Project manager's own checkout stays untouched. The engine owns the
// worktree, so it can reset it and delete files in it without losing anyone
// else's work.
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CommandRunner } from "../core.js";
import { Git } from "../range/git.js";

/** The directory, relative to the repository, that holds build worktrees. */
export const WORKTREES_DIR = ".worktrees";

/** The author of commits the engine makes when the repository names nobody. */
const ENGINE_AUTHOR = {
  GIT_AUTHOR_NAME: "AI Orchestrator",
  GIT_AUTHOR_EMAIL: "build@aio.invalid",
  GIT_COMMITTER_NAME: "AI Orchestrator",
  GIT_COMMITTER_EMAIL: "build@aio.invalid",
};

/** Thrown when the build branch or worktree already exists. */
export class WorktreeConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeConflict";
  }
}

/** The worktree at one moment: its `HEAD` and the blob of each path that differs from it. */
export interface WorktreeSnapshot {
  head: string;
  /** Each changed path's content as a Git blob ID, or `"none"` for a deleted path. */
  changed: Map<string, string>;
}

function nul(text: string): string[] {
  return text.split("\0").filter((p) => p !== "");
}

/**
 * Adds `pattern` to the repository's `info/exclude`, which every worktree
 * shares, unless a line there already names it.
 */
async function excludeInRepo(git: Git, pattern: string): Promise<void> {
  const commonDir = resolve(git.cwd, (await git.run(["rev-parse", "--git-common-dir"])).trim());
  const file = join(commonDir, "info", "exclude");
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const bare = pattern.replace(/^\/|\/$/g, "");
  const names = new Set([bare, `${bare}/`, `/${bare}`, `/${bare}/`]);
  if (text.split("\n").some((l) => names.has(l.trim()))) return;
  await mkdir(dirname(file), { recursive: true });
  const sep = text === "" || text.endsWith("\n") ? "" : "\n";
  await appendFile(file, `${sep}/${bare}/\n`);
}

export class BuildWorktree {
  /** Runs Git in the project's repository. */
  private readonly repo: Git;
  /** Runs Git in the build worktree. */
  readonly git: Git;

  constructor(
    runner: CommandRunner,
    readonly repoPath: string,
    readonly path: string,
    readonly branch: string,
  ) {
    this.repo = new Git(runner, repoPath);
    this.git = new Git(runner, path);
  }

  /** The worktree path of build `slug` in the repository at `repoPath`. */
  static pathFor(repoPath: string, slug: string): string {
    return join(repoPath, WORKTREES_DIR, `build-${slug}`);
  }

  /** The build branch of build `slug`. */
  static branchFor(slug: string): string {
    return `build/${slug}`;
  }

  /** Resolves `ref` in the project's repository; `HEAD` when absent. */
  async resolveBase(ref: string | undefined): Promise<string> {
    const sha = await this.repo.tryRevParse(ref ?? "HEAD");
    if (!sha) throw new Error(`The base ${ref ?? "HEAD"} isn't a commit in ${this.repoPath}.`);
    return sha;
  }

  /**
   * Creates the build branch at `base` and checks it out in the worktree.
   * Throws `WorktreeConflict` when either exists.
   */
  async create(base: string): Promise<void> {
    if (await this.repo.isLocalBranch(this.branch)) {
      throw new WorktreeConflict(`The branch ${this.branch} already exists in ${this.repoPath}.`);
    }
    if (existsSync(this.path)) {
      throw new WorktreeConflict(`The worktree ${this.path} already exists.`);
    }
    await excludeInRepo(this.repo, WORKTREES_DIR);
    await this.repo.excludeEngineDir().catch(() => false);
    await mkdir(dirname(this.path), { recursive: true });
    await this.repo.run(["worktree", "add", "-q", "-b", this.branch, this.path, base]);
  }

  /** Checks the build branch out again when its worktree is gone, such as after a cleanup. */
  async ensure(): Promise<void> {
    if (existsSync(join(this.path, ".git"))) return;
    await this.repo.ok(["worktree", "prune"]);
    await this.repo.run(["worktree", "add", "-q", this.path, this.branch]);
  }

  /**
   * Removes the worktree and the build branch from the repository, such as
   * when the owner deletes the build. Leaves nothing behind when either is
   * already gone.
   */
  async destroy(): Promise<void> {
    if (existsSync(this.path)) await this.repo.ok(["worktree", "remove", "--force", this.path]);
    await rm(this.path, { recursive: true, force: true });
    await this.repo.ok(["worktree", "prune"]);
    if (await this.repo.isLocalBranch(this.branch)) {
      await this.repo.run(["branch", "-D", this.branch]);
    }
  }

  head(): Promise<string> {
    return this.git.head();
  }

  /** Untracked files that Git doesn't ignore. */
  async untracked(): Promise<string[]> {
    return nul(await this.git.run(["ls-files", "--others", "--exclude-standard", "-z"]));
  }

  /**
   * Every path that differs from `base`: committed, staged, unstaged, and
   * untracked changes, with deletions and both sides of a rename.
   */
  async changedSince(base: string): Promise<string[]> {
    const tracked = nul(await this.git.run(["diff", "--name-only", "--no-renames", "-z", base]));
    return [...new Set([...tracked, ...(await this.untracked())])].sort();
  }

  /** The worktree's `HEAD` and the content of each path that differs from it. */
  async snapshot(): Promise<WorktreeSnapshot> {
    const head = await this.head();
    const changed = new Map<string, string>();
    for (const path of await this.changedSince(head)) changed.set(path, await this.blobOf(path));
    return { head, changed };
  }

  /**
   * The paths whose content differs from `before`, whether committed since
   * or not; the paths whose content is back where it was don't count.
   */
  async changedSinceSnapshot(before: WorktreeSnapshot): Promise<string[]> {
    const now = new Set(await this.changedSince(before.head));
    const paths: string[] = [];
    for (const path of new Set([...now, ...before.changed.keys()])) {
      const at = () => this.blobAt(before.head, path);
      const was = before.changed.get(path) ?? (await at());
      // A path that no longer differs from the old `HEAD` has its content there.
      const is = now.has(path) ? await this.blobOf(path) : await at();
      if (is !== was) paths.push(path);
    }
    return paths.sort();
  }

  /**
   * Puts each of `paths` back the way it was at `before`: a path that
   * didn't exist then is deleted, and any other gets its content back.
   */
  async restoreSnapshot(before: WorktreeSnapshot, paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      const blob = before.changed.get(path) ?? (await this.blobAt(before.head, path));
      if (blob === "none") {
        await this.git.run(["rm", "-q", "--cached", "--ignore-unmatch", "--", path]);
        await rm(join(this.path, path), { force: true, recursive: true });
        continue;
      }
      // Through the index, so a binary file comes back byte for byte.
      await this.git.run(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`]);
      await this.git.run(["checkout-index", "-f", "--", path]);
    }
  }

  /** The Git blob ID of a path's working copy, or `"none"` when it doesn't exist. */
  private async blobOf(path: string): Promise<string> {
    if (!existsSync(join(this.path, path))) return "none";
    return (await this.git.run(["hash-object", "--", path])).trim();
  }

  /** The Git blob ID of a path at `sha`, or `"none"` when it doesn't have it. */
  private async blobAt(sha: string, path: string): Promise<string> {
    const out = await this.git
      .run(["rev-parse", "-q", "--verify", `${sha}:${path}`])
      .catch(() => "");
    return out.trim() || "none";
  }

  /** True when the worktree has changes that aren't committed. */
  async dirty(): Promise<boolean> {
    return (await this.git.statusLines()).length > 0;
  }

  /** Commits every change in the worktree; returns the new `HEAD`. */
  async commitAll(message: string): Promise<string> {
    await this.git.run(["add", "-A"]);
    const named = (await this.git.ok(["config", "user.email"])) ? {} : ENGINE_AUTHOR;
    await this.git.run(["commit", "-q", "-m", message], { env: named });
    return this.head();
  }

  /**
   * Puts each of `paths` back the way it is at `sha`: a file that exists
   * there is checked out from it, and any other file is deleted. Other
   * changes stay as they are.
   */
  async restorePaths(sha: string, paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      if (await this.git.ok(["cat-file", "-e", `${sha}:${path}`])) {
        await this.git.run(["checkout", "-q", sha, "--", path]);
      } else {
        await this.git.run(["rm", "-q", "--cached", "--ignore-unmatch", "--", path]);
        await rm(join(this.path, path), { force: true, recursive: true });
      }
    }
  }

  /**
   * Sets aside every change since `base` except the paths in `keep`: saves
   * it as a patch in `patchFile`, puts the changed paths back the way they
   * are at `base`, and commits that with `message`. Returns the paths, or an
   * empty list when nothing changed.
   */
  async setAside(
    base: string,
    patchFile: string,
    message: string,
    keep: readonly string[] = [],
  ): Promise<string[]> {
    const paths = (await this.changedSince(base)).filter((p) => !keep.includes(p));
    if (paths.length === 0) return [];
    await mkdir(dirname(patchFile), { recursive: true });
    await this.git.run(["add", "-A", "--", ...paths]);
    await this.git.run([
      "diff",
      "--cached",
      "--binary",
      "--no-renames",
      `--output=${patchFile}`,
      base,
      "--",
      ...paths,
    ]);
    await this.restorePaths(base, paths);
    if (await this.dirty()) await this.commitAll(message);
    return paths;
  }

  /**
   * Applies a patch that `setAside()` saved. Returns false when it no longer
   * applies, with the paths it touches put back the way `HEAD` has them, so
   * no conflict stays in the worktree.
   */
  async bringBack(patchFile: string): Promise<boolean> {
    if (await this.git.ok(["apply", "--3way", "--whitespace=nowarn", patchFile])) return true;
    const numstat = await this.git.run(["apply", "--numstat", "-z", patchFile]).catch(() => "");
    const paths = numstat
      .split("\0")
      .map((entry) => entry.split("\t").at(-1) ?? "")
      .filter((path) => path !== "");
    await this.restorePaths("HEAD", paths);
    return false;
  }

  /** Deletes files in the worktree, such as a gate command's leftovers. */
  async remove(paths: readonly string[]): Promise<void> {
    for (const path of paths) await rm(join(this.path, path), { force: true, recursive: true });
  }
}
