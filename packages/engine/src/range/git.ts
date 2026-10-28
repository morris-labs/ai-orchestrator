// A thin `git` client over a `CommandRunner`.
import type { CommandRunner } from "../core.js";

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
    options: { input?: string; cwd?: string } = {},
  ): Promise<string> {
    const result = await this.runner.run("git", args, {
      cwd: options.cwd ?? this.cwd,
      input: options.input,
      timeoutMs: 120_000,
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

  /** The full diff with context, for prompts. */
  async diffForPrompt(
    from: string,
    to: string | null,
    paths: readonly string[] = [],
  ): Promise<string> {
    const args = ["diff", "--no-color", "--no-ext-diff", "--find-renames", "-U3", from];
    if (to !== null) args.push(to);
    if (paths.length > 0) args.push("--", ...paths);
    return this.run(args);
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
}
