import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY } from "@aio/contracts";
import { ExecaRunner } from "../../src/range/exec.js";
import { Git } from "../../src/range/git.js";
import { resolveRange } from "../../src/range/resolve.js";
import { resolveReviewRange } from "../../src/range/review-range.js";
import { buildSampleRepo } from "../state/scenario.js";
import { describe, expect, it } from "vitest";

const runner = new ExecaRunner();
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function fixture() {
  const repo = buildSampleRepo();
  const branchPoint = git(repo, "rev-parse", "main");
  git(repo, "checkout", "-qb", "moved", "main");
  writeFileSync(join(repo, "base-only.txt"), "Named base changes\n");
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.com",
    "commit",
    "-qm",
    "Advance the named base",
  );
  const namedBase = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "feature");
  return { repo, branchPoint, namedBase };
}

it("separates the change base from the named base and gives prompts the change base", async () => {
  const { repo, branchPoint, namedBase } = fixture();
  const request = {
    repoPath: repo,
    depth: "standard" as const,
    modelTier: "auto" as const,
    includeWorktree: false,
    exactBase: false,
  };
  const resolved = await resolveRange(runner, {
    ...request,
    base: "moved",
    mergeBase: true,
    exactBase: false,
    readOnly: true,
  });
  const range = await resolveReviewRange({
    git: new Git(runner, repo),
    resolved,
    request,
    policy: DEFAULT_POLICY,
  });
  expect(range.changeBase).toBe(branchPoint);
  expect(range.namedBaseSha).toBe(namedBase);
  expect(range.branchPoint).toBe(branchPoint);
  expect(range.promptRange.baseSha).toBe(branchPoint);
  expect(range.tipCommit).toBe(resolved.tipSha);
  expect(range.linesAt).toBe(resolved.tipSha);
  expect(range.groups.flatMap((group) => group.files)).not.toContain("base-only.txt");
});

const cases = ["standard", "thorough"].flatMap((depth) =>
  [false, true].flatMap((whole) =>
    [1, 2, 3].flatMap((round) =>
      [false, true].flatMap((exactBase) =>
        [false, true].map((worktree) => ({
          depth: depth as "standard" | "thorough",
          whole,
          round,
          exactBase,
          worktree,
        })),
      ),
    ),
  ),
);

describe("round review range", () => {
  it.each(cases)(
    "$depth whole=$whole round=$round exact=$exactBase worktree=$worktree",
    async ({ depth, whole, round, exactBase, worktree }) => {
      const { repo, branchPoint, namedBase } = fixture();
      const reviewedFrom = git(repo, "rev-parse", "HEAD");
      writeFileSync(join(repo, "fix-only.txt"), "A fix commit\n");
      git(repo, "add", ".");
      git(
        repo,
        "-c",
        "user.name=Example",
        "-c",
        "user.email=example@example.com",
        "commit",
        "-qm",
        "Record a fix",
      );
      if (worktree) writeFileSync(join(repo, "worktree-only.txt"), "Uncommitted change\n");
      const request = {
        repoPath: repo,
        ...(whole ? { scope: "whole" as const } : {}),
        depth,
        modelTier: "auto" as const,
        includeWorktree: worktree,
        exactBase,
      };
      const resolved = await resolveRange(runner, {
        ...request,
        base: "moved",
        mergeBase: true,
        readOnly: true,
      });
      const range = await resolveReviewRange({
        git: new Git(runner, repo),
        resolved,
        request,
        round,
        reviewedFrom: round === 3 ? reviewedFrom : undefined,
        policy: DEFAULT_POLICY,
      });
      const narrow = round === 3 && (depth === "standard" || whole);
      expect(range.changeBase).toBe(narrow ? reviewedFrom : resolved.diffBaseSha);
      expect(range.branchPoint).toBe(whole ? null : exactBase ? namedBase : branchPoint);
      expect(range.promptRange.baseSha).toBe(range.changeBase);
      expect(range.promptRange.tipSha).toBe(range.tipCommit);
      expect(range.tipCheckout.commit).toBe(range.tipCommit);
      expect(range.tipCheckout.head).toBe(resolved.tipSha);
      expect(range.worktree).toBe(worktree && round === 1);
      expect(range.linesAt).toBe(
        range.worktree ? `worktree:${resolved.tipSha}:${range.tipCommit}` : resolved.tipSha,
      );
      const files = [...new Set(range.groups.flatMap((group) => group.files))];
      expect(files).toContain("fix-only.txt");
      expect(files.includes("base-only.txt")).toBe(!whole && exactBase && !narrow);
      expect(files.includes("worktree-only.txt")).toBe(worktree && round === 1);
      if (narrow) expect(files).toEqual(["fix-only.txt"]);
      expect(range.groups.every((group) => group.tier !== undefined)).toBe(true);
    },
  );
});

it("keeps a snapshot across calls and refreshes it after a fix moves the tip", async () => {
  const { repo } = fixture();
  writeFileSync(join(repo, "worktree-only.txt"), "Reviewed text\n");
  const request = {
    repoPath: repo,
    depth: "standard" as const,
    includeWorktree: true,
    exactBase: false,
  };
  const resolved = await resolveRange(runner, {
    ...request,
    base: "moved",
    mergeBase: true,
    readOnly: true,
  });
  const repository = new Git(runner, repo);
  const input = { git: repository, resolved, request, policy: DEFAULT_POLICY };
  const first = await resolveReviewRange(input);
  writeFileSync(join(repo, "worktree-only.txt"), "Unreviewed edit\n");
  const reused = await resolveReviewRange({ ...input, saved: first });
  expect(reused.tipCommit).toBe(first.tipCommit);
  expect(await repository.show(reused.tipCommit, "worktree-only.txt")).toBe("Reviewed text\n");
  git(repo, "add", "worktree-only.txt");
  git(
    repo,
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.com",
    "commit",
    "-qm",
    "Apply a fix",
  );
  writeFileSync(join(repo, "worktree-only.txt"), "After-fix working tree\n");
  const fixed = await resolveReviewRange({
    ...input,
    tipSha: git(repo, "rev-parse", "HEAD"),
    saved: first,
  });
  expect(fixed.key).not.toBe(first.key);
  expect(fixed.tipCommit).not.toBe(first.tipCommit);
  expect(await repository.show(fixed.tipCommit, "worktree-only.txt")).toBe(
    "After-fix working tree\n",
  );
  expect(fixed.branchPoint).toBe(first.branchPoint);
});

it("keeps the branch point when merge-base diffing is disabled", async () => {
  const { repo, namedBase, branchPoint } = fixture();
  const request = { repoPath: repo, includeWorktree: false, exactBase: false };
  const resolved = await resolveRange(runner, {
    ...request,
    base: "moved",
    mergeBase: false,
    readOnly: true,
  });
  const range = await resolveReviewRange({
    git: new Git(runner, repo),
    resolved,
    request,
    policy: DEFAULT_POLICY,
  });
  expect(range.changeBase).toBe(namedBase);
  expect(range.branchPoint).toBe(branchPoint);
});

it("supports direct comparisons between unrelated histories without inventing a branch point", async () => {
  const { repo, namedBase } = fixture();
  git(repo, "checkout", "--orphan", "unrelated");
  git(repo, "rm", "-rf", ".");
  writeFileSync(join(repo, "unrelated.txt"), "Separate history\n");
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.name=Example",
    "-c",
    "user.email=example@example.com",
    "commit",
    "-qm",
    "Start an unrelated history",
  );
  const request = { repoPath: repo, includeWorktree: false, exactBase: false };
  const resolved = await resolveRange(runner, {
    ...request,
    base: "moved",
    mergeBase: false,
    readOnly: true,
  });
  const range = await resolveReviewRange({
    git: new Git(runner, repo),
    resolved,
    request,
    policy: DEFAULT_POLICY,
  });
  expect(range.changeBase).toBe(namedBase);
  expect(range.branchPoint).toBeNull();
  expect(range.groups.flatMap((group) => group.files)).toContain("unrelated.txt");
});
