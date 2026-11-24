// Snapshots of a build worktree, and putting refused changes back.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
    BuildWorktree.pathFor(repo, "snap"),
    BuildWorktree.branchFor("snap"),
  );
  await tree.create(await tree.resolveBase(undefined));
  return tree;
}

describe("BuildWorktree snapshots", () => {
  it("puts back a file that was dirty at the snapshot after a turn changes it", async () => {
    const tree = await worktree();
    const file = git(tree.path, "ls-files").split("\n")[0]!;
    // Uncommitted content Git has never stored.
    writeFileSync(join(tree.path, file), "dirty before the turn\n");
    const before = await tree.snapshot();

    writeFileSync(join(tree.path, file), "changed by the turn\n");
    expect(await tree.changedSinceSnapshot(before)).toEqual([file]);
    await tree.restoreSnapshot(before, [file]);

    expect(readFileSync(join(tree.path, file), "utf8")).toBe("dirty before the turn\n");
    expect(await tree.changedSinceSnapshot(before)).toEqual([]);
  });

  it("keeps an executable file executable when it puts the file back", async () => {
    const tree = await worktree();
    writeFileSync(join(tree.path, "run.sh"), "#!/bin/sh\necho one\n");
    chmodSync(join(tree.path, "run.sh"), 0o755);
    git(tree.path, "add", "run.sh");
    git(
      tree.path,
      "-c",
      "user.name=Example",
      "-c",
      "user.email=dev@example.com",
      "commit",
      "-qm",
      "add run.sh",
    );
    const before = await tree.snapshot();

    writeFileSync(join(tree.path, "run.sh"), "#!/bin/sh\necho two\n");
    await tree.restoreSnapshot(before, ["run.sh"]);

    expect(readFileSync(join(tree.path, "run.sh"), "utf8")).toBe("#!/bin/sh\necho one\n");
    expect(statSync(join(tree.path, "run.sh")).mode & 0o111).not.toBe(0);
  });
});

const commit = (cwd: string, message: string) =>
  git(cwd, "-c", "user.name=Example", "-c", "user.email=dev@example.com", "commit", "-qm", message);

describe("BuildWorktree set-aside", () => {
  it.each(["staged", "committed"] as const)(
    "sets aside a file the task deleted with a %s deletion, and brings it back",
    async (how) => {
      const tree = await worktree();
      const base = await tree.head();
      const file = git(tree.path, "ls-files").split("\n")[0]!;
      git(tree.path, "rm", "-q", "--", file);
      if (how === "committed") commit(tree.path, "delete a file");
      const patch = join(tree.path, "..", `set-aside-${how}.patch`);

      expect(await tree.setAside(base, patch, "set the task aside")).toEqual([file]);
      expect(existsSync(join(tree.path, file))).toBe(true);
      expect(await tree.bringBack(patch)).toBe(true);
      expect(existsSync(join(tree.path, file))).toBe(false);
    },
  );
});

describe("BuildWorktree paths", () => {
  it("puts back a path with brackets without touching the paths it would match as a glob", async () => {
    const tree = await worktree();
    mkdirSync(join(tree.path, "app/[slug]"), { recursive: true });
    mkdirSync(join(tree.path, "app/s"), { recursive: true });
    writeFileSync(join(tree.path, "app/[slug]/page.ts"), "one\n");
    writeFileSync(join(tree.path, "app/s/page.ts"), "one\n");
    git(tree.path, "add", "-A");
    commit(tree.path, "add the pages");
    const base = await tree.head();
    writeFileSync(join(tree.path, "app/[slug]/page.ts"), "two\n");
    writeFileSync(join(tree.path, "app/s/page.ts"), "two\n");

    await tree.restorePaths(base, ["app/[slug]/page.ts"]);

    expect(readFileSync(join(tree.path, "app/[slug]/page.ts"), "utf8")).toBe("one\n");
    expect(readFileSync(join(tree.path, "app/s/page.ts"), "utf8")).toBe("two\n");
  });
});
