// RepoService against real git repositories in a temporary directory, with
// `gh` replaced by a fake.
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RepoInfoSchema, RepoRefsSchema } from "@aio/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RepoService } from "../../src/api/repos.js";
import { execRunner, type CommandRunner } from "../../src/api/runner.js";
import { silentLogger } from "../../src/main/logger.js";
import { tempDir } from "../tmp.js";

let root: string;
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Author",
  GIT_COMMITTER_EMAIL: "author@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" });

let ghOutput = { code: 0, stdout: "[]", stderr: "" };
const runner: CommandRunner = {
  run: (program, args, options) =>
    program === "gh"
      ? Promise.resolve(ghOutput)
      : execRunner.run(program, args, { ...options, env }),
};

beforeAll(() => {
  root = tempDir("engine-repos-");
  git(root, "init", "-q", "-b", "main");
  writeFileSync(path.join(root, "a.txt"), "one\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-q", "-m", "First commit");
  git(root, "tag", "v1.0.0");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  writeFileSync(path.join(root, ".git", "info", "exclude"), ".worktrees/\n");
  git(
    root,
    "worktree",
    "add",
    "-q",
    "-b",
    "claude/feature",
    path.join(root, ".worktrees", "feature"),
  );
  writeFileSync(path.join(root, ".worktrees", "feature", "b.txt"), "dirty\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const service = () => new RepoService({ projectRoot: root, runner, log: silentLogger });

describe("RepoService", () => {
  it("lists the root and each worktree", async () => {
    const repos = await service().list();
    for (const r of repos) RepoInfoSchema.parse(r);
    expect(repos.map((r) => [r.name, r.currentBranch, r.dirty])).toEqual([
      [path.basename(root), "main", false],
      ["feature", "claude/feature", true],
    ]);
    expect(repos[0]?.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reads branches, tags, commits, and pull requests", async () => {
    ghOutput = {
      code: 0,
      stdout: JSON.stringify([
        {
          number: 7,
          title: "Fix it",
          headRefName: "claude/feature",
          baseRefName: "main",
          url: "https://github.com/example/repo/pull/7",
        },
      ]),
      stderr: "",
    };
    const refs = RepoRefsSchema.parse(await service().refs(root));
    expect(refs.localBranches).toEqual(["claude/feature", "main"]);
    expect(refs.remoteBranches).toEqual(["origin/main"]);
    expect(refs.tags).toEqual(["v1.0.0"]);
    expect(refs.recentCommits).toHaveLength(1);
    expect(refs.recentCommits[0]).toMatchObject({ subject: "First commit", author: "Test Author" });
    expect(refs.pullRequests).toEqual([
      {
        number: 7,
        title: "Fix it",
        headRef: "claude/feature",
        baseRef: "main",
        url: "https://github.com/example/repo/pull/7",
      },
    ]);
  });

  it("reports no pull requests when gh fails or prints junk", async () => {
    ghOutput = { code: 1, stdout: "", stderr: "not logged in" };
    expect((await service().refs(root)).pullRequests).toEqual([]);
    ghOutput = { code: 0, stdout: "not json", stderr: "" };
    expect((await service().refs(root)).pullRequests).toEqual([]);
  });

  it("offers the broker's token to github.com only when it fetches", async () => {
    const seen: string[][] = [];
    const capture: CommandRunner = {
      run: (program, args, options) => {
        if (args.includes("fetch")) seen.push([...args]);
        return runner.run(program, args, options);
      },
    };
    const repos = new RepoService({ projectRoot: root, runner: capture, log: silentLogger });
    await repos.refs(root, true);
    const settings = seen[0]!.filter((a) => a.startsWith("credential."));
    expect(settings).toHaveLength(2);
    for (const s of settings) expect(s).toMatch(/^credential\.https:\/\/github\.com\.helper=/);
  });

  it("gives git longer than the runner's default, and a fetch the longest", async () => {
    const timeouts = new Map<string, number | undefined>();
    const capture: CommandRunner = {
      run: (program, args, options) => {
        if (program === "git")
          timeouts.set(args.includes("fetch") ? "fetch" : "read", options?.timeoutMs);
        return runner.run(program, args, options);
      },
    };
    const repos = new RepoService({ projectRoot: root, runner: capture, log: silentLogger });
    await repos.refs(root, true);
    expect(timeouts.get("read")).toBe(60_000);
    expect(timeouts.get("fetch")).toBe(180_000);
  });

  it("accepts a worktree path relative to the root", async () => {
    const refs = await service().refs(".worktrees/feature");
    expect(refs.localBranches).toContain("claude/feature");
  });

  it("refuses a path that isn't a listed repository", async () => {
    await expect(service().refs("/etc")).rejects.toMatchObject({ code: "not_found" });
  });

  it("lists nothing under a root that isn't a repository", async () => {
    const empty = tempDir("engine-empty-");
    try {
      expect(
        await new RepoService({ projectRoot: empty, runner, log: silentLogger }).list(),
      ).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
