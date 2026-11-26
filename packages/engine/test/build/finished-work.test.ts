// Other tasks' finished work in a task's changes, when the task's base is
// older than their commits.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finishedWork } from "../../src/build/finished-work.js";
import { BuildWorktree } from "../../src/build/worktree.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { buildSampleRepo } from "../state/scenario.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function worktree(): Promise<BuildWorktree> {
  const repo = buildSampleRepo();
  const tree = new BuildWorktree(
    new ExecaRunner(),
    repo,
    BuildWorktree.pathFor(repo, "finished"),
    BuildWorktree.branchFor("finished"),
  );
  await tree.create(await tree.resolveBase(undefined));
  return tree;
}

function commit(tree: BuildWorktree, files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files))
    writeFileSync(join(tree.path, path), content);
  git(tree.path, "add", "-A");
  git(
    tree.path,
    "-c",
    "user.name=Example",
    "-c",
    "user.email=build@example.com",
    "commit",
    "-q",
    "-m",
    message,
  );
  return git(tree.path, "rev-parse", "HEAD");
}

describe("finishedWork", () => {
  it("names the paths that hold a finished task's work, not the task's own changes", async () => {
    const tree = await worktree();
    const staleBase = await tree.head();
    // The waiting task's own commit, then a task that finishes after its base.
    commit(tree, { "own.txt": "the waiting task's work\n" }, "feat: own work");
    const otherBase = await tree.head();
    const other = commit(
      tree,
      { "other.txt": "finished work\n", "shared.txt": "finished\n" },
      "feat: other task",
    );
    // The waiting task's uncommitted change, and a revert of finished work.
    writeFileSync(join(tree.path, "draft.txt"), "uncommitted\n");
    git(tree.path, "rm", "-q", "--cached", "shared.txt");
    writeFileSync(join(tree.path, "shared.txt"), "reverted by hand\n");

    const changed = await tree.changedSince(staleBase);
    expect(changed).toEqual(["draft.txt", "other.txt", "own.txt", "shared.txt"]);
    expect(await finishedWork(tree, changed, [{ base: otherBase, commit: other }])).toEqual([
      "other.txt",
    ]);
  });

  it("uses the newest finished commit, and skips tasks without a commit on the branch", async () => {
    const tree = await worktree();
    const staleBase = await tree.head();
    const firstBase = staleBase;
    const first = commit(tree, { "file.txt": "first\n" }, "feat: first task");
    const second = commit(tree, { "file.txt": "second\n" }, "feat: second task");
    const changed = await tree.changedSince(staleBase);

    expect(
      await finishedWork(tree, changed, [
        { base: firstBase, commit: first },
        { base: first, commit: second },
        { base: firstBase, commit: null },
        { base: firstBase, commit: "0".repeat(40) },
      ]),
    ).toEqual(["file.txt"]);
    // Content that only the older task's commit has isn't finished work any more.
    writeFileSync(join(tree.path, "file.txt"), "first\n");
    expect(
      await finishedWork(tree, changed, [
        { base: firstBase, commit: first },
        { base: first, commit: second },
      ]),
    ).toEqual([]);
  });
});
