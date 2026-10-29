import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GitHubClient } from "../../src/postpush/github.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { Git } from "../../src/range/git.js";
import { RangeError, resolveRange, type RangeInput } from "../../src/range/resolve.js";
import { buildSampleRepo } from "../state/scenario.js";

const runner = new ExecaRunner();
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function input(repo: string, extra: Partial<RangeInput> = {}): RangeInput {
  return {
    repoPath: repo,
    base: "origin/main",
    mergeBase: true,
    exactBase: false,
    readOnly: false,
    includeWorktree: false,
    ...extra,
  };
}

describe("resolveRange", () => {
  const repo = buildSampleRepo();
  const mainSha = git(repo, "rev-parse", "main");
  const tipSha = git(repo, "rev-parse", "feature");

  it("pins the base and uses the merge base by default", async () => {
    const r = await resolveRange(runner, input(repo));
    expect(r).toMatchObject({
      baseRef: "origin/main",
      baseSha: mainSha,
      tipRef: "feature",
      tipSha,
      diffBaseSha: mainSha,
      dirty: false,
    });
  });

  it("diffs from the merge base, not a moved base", async () => {
    git(repo, "checkout", "-q", "-b", "moved", "main");
    writeFileSync(join(repo, "extra.txt"), "x\n");
    git(repo, "add", "extra.txt");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "move");
    const moved = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "feature");
    const merged = await resolveRange(runner, input(repo, { base: "moved" }));
    expect(merged.baseSha).toBe(moved);
    expect(merged.diffBaseSha).toBe(mainSha);
    const exact = await resolveRange(runner, input(repo, { base: "moved", exactBase: true }));
    expect(exact.diffBaseSha).toBe(moved);
  });

  it("refuses a commit tip unless read-only", async () => {
    await expect(resolveRange(runner, input(repo, { tip: tipSha }))).rejects.toMatchObject({
      code: "sha_tip_needs_read_only",
    });
    const r = await resolveRange(runner, input(repo, { tip: tipSha, readOnly: true }));
    expect(r.tipRef).toBeNull();
    expect(r.tipSha).toBe(tipSha);
  });

  it("refuses a tip branch that isn't checked out, unless read-only", async () => {
    await expect(resolveRange(runner, input(repo, { tip: "main" }))).rejects.toMatchObject({
      code: "tip_not_checked_out",
    });
    await expect(
      resolveRange(runner, input(repo, { tip: "main", readOnly: true })),
    ).resolves.toMatchObject({ tipRef: "main" });
  });

  it("refuses a dirty tree unless the working tree is included", async () => {
    writeFileSync(join(repo, "shop/pricing.py"), "# changed\n", { flag: "a" });
    const err = await resolveRange(runner, input(repo)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RangeError);
    expect((err as RangeError).code).toBe("dirty_tree");
    const r = await resolveRange(runner, input(repo, { includeWorktree: true }));
    expect(r.dirty).toBe(true);
    expect(r.includeWorktree).toBe(true);
    const diff = await new Git(runner, repo).diff(r.diffBaseSha, null);
    expect(diff).toContain("# changed");
    git(repo, "checkout", "--", "shop/pricing.py");
  });

  it("doesn't count files git ignores as a dirty tree", async () => {
    const { mkdirSync, rmSync } = await import("node:fs");
    writeFileSync(join(repo, ".git", "info", "exclude"), "__pycache__/\n", { flag: "a" });
    mkdirSync(join(repo, "shop", "__pycache__"), { recursive: true });
    writeFileSync(join(repo, "shop", "__pycache__", "pricing.cpython-312.pyc"), "x");
    await expect(resolveRange(runner, input(repo))).resolves.toMatchObject({ dirty: false });
    rmSync(join(repo, "shop", "__pycache__"), { recursive: true });
  });

  it("reports a bad base", async () => {
    await expect(resolveRange(runner, input(repo, { base: "nope" }))).rejects.toMatchObject({
      code: "bad_ref",
    });
  });

  it("reads the base branch from the pull request for base pr", async () => {
    const gh = {
      viewPr: async (_repo: string, selector: number | string) => ({
        number: 4,
        url: "https://example.com/pr/4",
        headRefName: String(selector),
        baseRefName: "main",
        headSha: tipSha,
        state: "OPEN" as const,
      }),
    } as unknown as GitHubClient;
    const r = await resolveRange(runner, input(repo, { base: "pr" }), gh);
    expect(r.baseRef).toBe("origin/main");
    await expect(resolveRange(runner, input(repo, { base: "pr" }))).rejects.toMatchObject({
      code: "no_pr",
    });
  });
});
