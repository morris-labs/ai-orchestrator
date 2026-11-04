// Repositories under the project root: the root itself and every worktree in
// `<root>/.worktrees/`. Git does the reading; `gh` lists open pull requests.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Logger } from "./core-interface.js";
import { EngineError } from "./core-interface.js";
import type { CommandRunner } from "./runner.js";

export interface RepoInfo {
  path: string;
  name: string;
  currentBranch: string | null;
  headSha: string | null;
  dirty: boolean;
}

export interface RepoRefs {
  localBranches: string[];
  remoteBranches: string[];
  fetchError?: string;
  tags: string[];
  recentCommits: { sha: string; subject: string; author: string; time: string }[];
  pullRequests: { number: number; title: string; headRef: string; baseRef: string; url: string }[];
}

export interface RepoServiceOptions {
  projectRoot: string;
  runner: CommandRunner;
  log: Logger;
  /** How many commits `refs` returns. */
  commitLimit?: number;
}

const SEP = "\x1f";

export class RepoService {
  private readonly root: string;
  private readonly commitLimit: number;

  constructor(private readonly options: RepoServiceOptions) {
    this.root = path.resolve(options.projectRoot);
    this.commitLimit = options.commitLimit ?? 20;
  }

  /** The candidate repository paths: the root and each `.worktrees/*` directory with a `.git`. */
  repoPaths(): string[] {
    const paths: string[] = [];
    if (existsSync(path.join(this.root, ".git"))) paths.push(this.root);
    const worktrees = path.join(this.root, ".worktrees");
    let entries: string[] = [];
    try {
      entries = readdirSync(worktrees, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      // No worktrees directory.
    }
    for (const name of entries) {
      const dir = path.join(worktrees, name);
      if (existsSync(path.join(dir, ".git"))) paths.push(dir);
    }
    return paths;
  }

  async list(): Promise<RepoInfo[]> {
    return Promise.all(this.repoPaths().map((p) => this.info(p)));
  }

  async info(repo: string): Promise<RepoInfo> {
    const [branch, head, status] = await Promise.all([
      this.git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]),
      this.git(repo, ["rev-parse", "-q", "--verify", "HEAD"]),
      this.git(repo, ["status", "--porcelain"]),
    ]);
    return {
      path: repo,
      name: path.basename(repo),
      currentBranch: branch.code === 0 && branch.stdout.trim() !== "" ? branch.stdout.trim() : null,
      headSha: head.code === 0 && head.stdout.trim() !== "" ? head.stdout.trim() : null,
      dirty: status.code === 0 && status.stdout.trim() !== "",
    };
  }

  /** Resolves `repo` to a listed repository, or throws `not_found`. */
  resolve(repo: string): string {
    const wanted = path.resolve(this.root, repo);
    const found = this.repoPaths().find((p) => p === wanted);
    if (!found)
      throw new EngineError("not_found", `No repository at ${repo} under the project root.`);
    return found;
  }

  async refs(repo: string, fetch = false): Promise<RepoRefs> {
    const dir = this.resolve(repo);
    let fetchError: string | undefined;
    if (fetch) {
      // The container has no stored Git sign-in. The helper asks the secrets
      // broker when Git needs it, so the token never reaches a command line.
      // It applies to github.com only, so another remote never gets the token.
      const fetched = await this.git(dir, [
        "-c",
        "credential.https://github.com.helper=",
        "-c",
        `credential.https://github.com.helper=${BROKER_CREDENTIAL_HELPER}`,
        "fetch",
        "--all",
        "--prune",
      ]);
      if (fetched.code !== 0) {
        fetchError = (fetched.stderr ?? "").trim().slice(-500) || "git fetch failed.";
      }
    }
    const [heads, remotes, tags, log, pullRequests] = await Promise.all([
      this.git(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
      this.git(dir, ["for-each-ref", "--format=%(refname)", "refs/remotes"]),
      this.git(dir, [
        "for-each-ref",
        "--sort=-creatordate",
        "--format=%(refname:short)",
        "refs/tags",
      ]),
      this.git(dir, [
        "log",
        `-n${this.commitLimit}`,
        `--format=%H${SEP}%s${SEP}%an${SEP}%aI`,
        "HEAD",
        "--",
      ]),
      this.pullRequests(dir),
    ]);
    return {
      ...(fetchError ? { fetchError } : {}),
      localBranches: lines(heads.stdout),
      remoteBranches: lines(remotes.stdout)
        .map((r) => r.replace(/^refs\/remotes\//, ""))
        .filter((r) => !r.endsWith("/HEAD")),
      tags: lines(tags.stdout),
      recentCommits:
        log.code === 0
          ? lines(log.stdout).map((line) => {
              const [sha = "", subject = "", author = "", time = ""] = line.split(SEP);
              return { sha, subject, author, time };
            })
          : [],
      pullRequests,
    };
  }

  private async pullRequests(dir: string): Promise<RepoRefs["pullRequests"]> {
    const result = await this.options.runner.run(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        "50",
        "--json",
        "number,title,headRefName,baseRefName,url",
      ],
      { cwd: dir, timeoutMs: 20_000 },
    );
    if (result.code !== 0) {
      this.options.log.debug("gh pr list failed; reporting no pull requests", {
        repo: dir,
        exitCode: result.code,
      });
      return [];
    }
    try {
      const parsed = JSON.parse(result.stdout) as {
        number: number;
        title: string;
        headRefName: string;
        baseRefName: string;
        url: string;
      }[];
      return parsed.map((pr) => ({
        number: pr.number,
        title: pr.title,
        headRef: pr.headRefName,
        baseRef: pr.baseRefName,
        url: pr.url,
      }));
    } catch {
      this.options.log.warn("gh pr list returned output that isn't JSON", { repo: dir });
      return [];
    }
  }

  private git(dir: string, args: string[]) {
    return this.options.runner.run("git", ["-C", dir, ...args]);
  }
}

const BROKER_CREDENTIAL_HELPER =
  '!f() { echo "username=x-access-token"; echo "password=$(aio-secret get GH_TOKEN)"; }; f';

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}
