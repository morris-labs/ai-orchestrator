// A thin `git` client over a `CommandRunner`.
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CommandRunner } from "../core.js";

/** The `info/exclude` line that hides the engine's own directory. */
const ENGINE_DIR_PATTERN = ".claude-box/";

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed with exit code ${exitCode}: ${stderr.trim()}`);
    this.name = "GitError";
  }
}

export class Git {
  constructor(
    private readonly runner: CommandRunner,
    readonly cwd: string,
  ) {}

  /** Runs git and returns its standard output; throws `GitError` on a non-zero exit. */
  async run(
    args: readonly string[],
    options: { input?: string; cwd?: string; env?: Record<string, string> } = {},
  ): Promise<string> {
    const result = await this.runner.run("git", args, {
      cwd: options.cwd ?? this.cwd,
      input: options.input,
      timeoutMs: 120_000,
      ...(options.env ? { env: options.env } : {}),
    });
    if (result.exitCode !== 0) throw new GitError(args, result.exitCode, result.stderr);
    return result.stdout;
  }

  /** Runs git and reports success instead of throwing. */
  async ok(args: readonly string[]): Promise<boolean> {
    const result = await this.runner.run("git", args, { cwd: this.cwd, timeoutMs: 120_000 });
    return result.exitCode === 0;
  }

  async revParse(ref: string): Promise<string> {
    return (await this.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
  }

  async tryRevParse(ref: string): Promise<string | null> {
    const result = await this.runner.run(
      "git",
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      {
        cwd: this.cwd,
        timeoutMs: 60_000,
      },
    );
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  /** The checked-out branch, or `null` on a detached HEAD. */
  async currentBranch(): Promise<string | null> {
    const result = await this.runner.run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: this.cwd,
      timeoutMs: 60_000,
    });
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  async isLocalBranch(name: string): Promise<boolean> {
    return this.ok(["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
  }

  async mergeBase(a: string, b: string): Promise<string> {
    return (await this.run(["merge-base", a, b])).trim();
  }

  /**
   * Adds `.claude-box/` to the repository's `info/exclude`, which every
   * worktree of the repository shares, unless a line there already names
   * it. Returns whether it added the line.
   */
  async excludeEngineDir(): Promise<boolean> {
    const commonDir = resolve(this.cwd, (await this.run(["rev-parse", "--git-common-dir"])).trim());
    const file = join(commonDir, "info", "exclude");
    let text = "";
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const names = new Set([".claude-box", ".claude-box/", "/.claude-box", "/.claude-box/"]);
    if (text.split("\n").some((l) => names.has(l.trim()))) return false;
    await mkdir(dirname(file), { recursive: true });
    const sep = text === "" || text.endsWith("\n") ? "" : "\n";
    await appendFile(file, `${sep}${ENGINE_DIR_PATTERN}\n`);
    return true;
  }

  /** `git status --porcelain` lines, untracked files included, ignored files not. */
  async statusLines(): Promise<string[]> {
    const out = await this.run(["status", "--porcelain", "--untracked-files=all"]);
    return out.split("\n").filter((l) => l.trim() !== "");
  }

  /**
   * The unified diff with no context from `from` to `to`, or to the working
   * tree when `to` is `null`.
   */
  async diff(from: string, to: string | null, extra: readonly string[] = []): Promise<string> {
    const args = ["diff", "--no-color", "--no-ext-diff", "--find-renames", "-U0", ...extra, from];
    if (to !== null) args.push(to);
    return this.run(args);
  }

  /**
   * The full diff with context, for prompts. A renamed file in `paths` also
   * brings its old path into the pathspec, so git pairs the two and shows
   * the rename instead of an entirely new file.
   */
  async diffForPrompt(
    from: string,
    to: string | null,
    paths: readonly string[] = [],
  ): Promise<string> {
    const args = ["diff", "--no-color", "--no-ext-diff", "--find-renames", "-U3", from];
    if (to !== null) args.push(to);
    if (paths.length > 0) {
      args.push("--", ...paths, ...(await this.renameSources(from, to, paths)));
    }
    return this.run(args);
  }

  /** The old paths of the files in `paths` that the diff from `from` to `to` renames. */
  private async renameSources(
    from: string,
    to: string | null,
    paths: readonly string[],
  ): Promise<string[]> {
    const args = ["diff", "--no-ext-diff", "--find-renames", "--name-status", "-z", from];
    if (to !== null) args.push(to);
    // With -z, each entry is the status, then one path, or two for a rename or copy.
    const fields = (await this.run(args)).split("\0");
    const wanted = new Set(paths);
    const sources: string[] = [];
    let i = 0;
    while (i < fields.length) {
      const status = fields[i] ?? "";
      if (status === "") {
        i += 1;
        continue;
      }
      if (/^[RC]/.test(status)) {
        const oldPath = fields[i + 1] ?? "";
        const newPath = fields[i + 2] ?? "";
        if (status.startsWith("R") && wanted.has(newPath) && !wanted.has(oldPath)) {
          sources.push(oldPath);
        }
        i += 3;
      } else {
        i += 2;
      }
    }
    return sources;
  }

  /** The content of `path` at `rev`, or `null` when it doesn't exist there. */
  async show(rev: string, path: string): Promise<string | null> {
    const result = await this.runner.run("git", ["show", `${rev}:${path}`], {
      cwd: this.cwd,
      timeoutMs: 60_000,
    });
    return result.exitCode === 0 ? result.stdout : null;
  }

  async head(): Promise<string> {
    return this.revParse("HEAD");
  }

  /** Commits reachable from `to` and not from `from`, oldest first. */
  async commitsBetween(from: string, to: string): Promise<string[]> {
    const out = await this.run(["rev-list", "--reverse", `${from}..${to}`]);
    return out.split("\n").filter((l) => l.trim() !== "");
  }

  async addDetachedWorktree(path: string, rev: string): Promise<void> {
    await this.run(["worktree", "add", "--detach", "--force", path, rev]);
  }

  async removeWorktree(path: string): Promise<void> {
    await this.ok(["worktree", "remove", "--force", path]);
    await this.ok(["worktree", "prune"]);
  }

  /**
   * A commit whose tree is the working tree: `HEAD` plus the tracked changes
   * and the untracked files git doesn't ignore, without `.claude-box/`.
   * Returns `HEAD` itself when the working tree has no changes. The commit
   * is built in a temporary index file, so the checkout's own index, its
   * files, and its refs stay as they are; the commit is reachable from no
   * ref.
   */
  async snapshotWorktree(indexFile: string): Promise<string> {
    const head = await this.head();
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await this.run(["read-tree", head], { env });
      await this.run(["add", "--all", "--", ".", ":(exclude).claude-box"], { env });
      const tree = (await this.run(["write-tree"], { env })).trim();
      const headTree = (await this.revParseTree(head)).trim();
      if (tree === headTree) return head;
      const commit = await this.run(
        ["commit-tree", tree, "-p", head, "-m", "Agent Box snapshot of the working tree"],
        { env: SNAPSHOT_IDENTITY },
      );
      return commit.trim();
    } finally {
      await rm(indexFile, { force: true });
    }
  }

  private revParseTree(rev: string): Promise<string> {
    return this.run(["rev-parse", "--verify", "--quiet", `${rev}^{tree}`]);
  }
}

/** The author and committer of a snapshot commit, so `commit-tree` needs no user settings. */
const SNAPSHOT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "Agent Box",
  GIT_AUTHOR_EMAIL: "agentbox@localhost",
  GIT_COMMITTER_NAME: "Agent Box",
  GIT_COMMITTER_EMAIL: "agentbox@localhost",
};
