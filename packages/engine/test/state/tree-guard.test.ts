import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessRunner } from "../../src/range/exec.js";
import { Git } from "../../src/range/git.js";
import { EngineCheckout } from "../../src/state/checkout.js";
import {
  ReadOnlyViolation,
  TreeGuard,
  describeTreeChange,
  isBytecode,
  parsePorcelainZ,
  snapshotTree,
} from "../../src/state/tree-guard.js";
import { tempDir } from "../tmp.js";

const runner = new ProcessRunner();

function repo(): string {
  const dir = tempDir("tree-guard-");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.py"), "print(1)\n");
  writeFileSync(join(dir, ".gitignore"), "__pycache__/\n");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

describe("snapshotTree", () => {
  it("sees edits, new files, and commits, but not ignored or excluded paths", async () => {
    const dir = repo();
    const runs = join(dir, ".claude-box", "runs", "r1");
    const before = await snapshotTree(runner, dir, [runs]);
    mkdirSync(join(dir, "__pycache__"));
    writeFileSync(join(dir, "__pycache__", "a.pyc"), "x");
    mkdirSync(join(runs, "scratch"), { recursive: true });
    writeFileSync(join(runs, "scratch", "repro.py"), "x");
    expect(describeTreeChange(before, await snapshotTree(runner, dir, [runs]))).toBeNull();

    writeFileSync(join(dir, "a.py"), "print(2)\n");
    writeFileSync(join(dir, "new.txt"), "n");
    const after = await snapshotTree(runner, dir, [runs]);
    expect(describeTreeChange(before, after)).toMatch(/files changed: .*a\.py/);
    expect(describeTreeChange(before, after)).toMatch(/new\.txt/);
  });

  it("leaves Python bytecode out in a repository that doesn't ignore it", async () => {
    const dir = repo();
    writeFileSync(join(dir, ".gitignore"), "");
    const before = await snapshotTree(runner, dir);
    mkdirSync(join(dir, "__pycache__"));
    writeFileSync(join(dir, "__pycache__", "a.cpython-314.pyc"), "x");
    mkdirSync(join(dir, "pkg", "__pycache__"), { recursive: true });
    writeFileSync(join(dir, "pkg", "__pycache__", "b.cpython-314.pyc"), "x");
    writeFileSync(join(dir, "pkg", "c.pyc"), "x");
    expect(describeTreeChange(before, await snapshotTree(runner, dir))).toBeNull();
    writeFileSync(join(dir, "pkg", "d.py"), "x");
    expect(describeTreeChange(before, await snapshotTree(runner, dir))).toMatch(/pkg\/d\.py/);
    expect(isBytecode("pycache_notes/x.py")).toBe(false);
    expect(isBytecode("my__pycache__/x.py")).toBe(false);
  });

  it("sees a second edit to a file that was already changed", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.py"), "print(2)\n");
    const before = await snapshotTree(runner, dir);
    writeFileSync(join(dir, "a.py"), "print(3)\n");
    expect(describeTreeChange(before, await snapshotTree(runner, dir))).toMatch(/content/);
  });

  it("parses renames in porcelain -z output", () => {
    expect(parsePorcelainZ("R  new.txt\0old.txt\0?? x\0")).toEqual([
      { code: "R ", path: "new.txt" },
      { code: "R ", path: "old.txt" },
      { code: "??", path: "x" },
    ]);
  });
});

describe("TreeGuard", () => {
  /** An engine checkout of `dir`'s `HEAD` in a temporary directory, and a guard that restores it. */
  async function engineCheckout(dir: string) {
    const git = new Git(runner, dir);
    const checkout = new EngineCheckout(git, join(tempDir("tree-guard-wt-"), "tip"));
    const head = await git.head();
    const path = await checkout.ensure({ commit: head, head });
    const guard = new TreeGuard({
      runner,
      repoPath: path,
      ignore: [],
      restore: () => checkout.reset(),
    });
    return { checkout, path, guard };
  }

  it("passes a call that changes nothing", async () => {
    const dir = repo();
    const guard = new TreeGuard({ runner, repoPath: dir, ignore: [] });
    await expect(guard.run(async () => 42)).resolves.toBe(42);
  });

  it("reports a change in a worktree it doesn't own and leaves every file in place", async () => {
    const dir = repo();
    const guard = new TreeGuard({ runner, repoPath: dir, ignore: [] });
    // A person edits the checkout while the call runs; the guard can't tell
    // their work from the agent's, so it must not touch either.
    const err = (await guard
      .run(async () => {
        writeFileSync(join(dir, "a.py"), "print('SYNTHETIC person edit')\n");
        writeFileSync(join(dir, "SYNTHETIC_new.py"), "work in progress\n");
      })
      .catch((e: unknown) => e)) as ReadOnlyViolation;
    expect(err).toBeInstanceOf(ReadOnlyViolation);
    expect(err.restored).toBe(false);
    expect(err.message).toMatch(/doesn't own this worktree/);
    expect(readFileSync(join(dir, "a.py"), "utf8")).toBe("print('SYNTHETIC person edit')\n");
    expect(readFileSync(join(dir, "SYNTHETIC_new.py"), "utf8")).toBe("work in progress\n");
  });

  it("restores an engine checkout that a call edited and committed to", async () => {
    const dir = repo();
    const liveHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
    const { path, guard } = await engineCheckout(dir);
    const err = await guard
      .run(async () => {
        writeFileSync(join(path, "a.py"), "print('edited')\n");
        writeFileSync(join(path, "stray.txt"), "s");
        execFileSync(
          "git",
          ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qam", "x"],
          { cwd: path },
        );
        return "answer";
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadOnlyViolation);
    expect((err as ReadOnlyViolation).restored).toBe(true);
    expect((err as Error).message).toMatch(/HEAD moved/);
    expect(readFileSync(join(path, "a.py"), "utf8")).toBe("print(1)\n");
    expect(existsSync(join(path, "stray.txt"))).toBe(false);
    // The checkout under review and its branch never moved.
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" })).toBe(
      liveHead,
    );
    expect(existsSync(join(dir, "stray.txt"))).toBe(false);
  });

  it("keeps a failed call's own error and still restores the engine checkout", async () => {
    const dir = repo();
    const { path, guard } = await engineCheckout(dir);
    const notes: string[] = [];
    await expect(
      guard.run(
        async () => {
          writeFileSync(join(path, "stray.txt"), "s");
          throw new Error("the CLI crashed");
        },
        (m) => notes.push(m),
      ),
    ).rejects.toThrow("the CLI crashed");
    expect(existsSync(join(path, "stray.txt"))).toBe(false);
    expect(notes[0]).toMatch(/stray\.txt/);
  });

  it("compares overlapping calls against one baseline", async () => {
    const dir = repo();
    const { path, guard } = await engineCheckout(dir);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = guard.run(async () => {
      await gate;
      return "slow";
    });
    const writer = guard.run(async () => {
      writeFileSync(join(path, "stray.txt"), "s");
    });
    await expect(writer).rejects.toBeInstanceOf(ReadOnlyViolation);
    release();
    await expect(slow).resolves.toBe("slow");
  });
});

describe("EngineCheckout", () => {
  it("shows a snapshot's uncommitted changes as uncommitted and leaves the source alone", async () => {
    const dir = repo();
    writeFileSync(join(dir, "a.py"), "print(2)\n");
    writeFileSync(join(dir, "SYNTHETIC_new.py"), "n\n");
    execFileSync("git", ["add", "a.py"], { cwd: dir });
    const statusBefore = execFileSync("git", ["status", "--porcelain"], {
      cwd: dir,
      encoding: "utf8",
    });
    const git = new Git(runner, dir);
    const head = await git.head();
    const commit = await git.snapshotWorktree(join(tempDir("tree-guard-idx-"), "index"));
    expect(commit).not.toBe(head);
    const checkout = new EngineCheckout(git, join(tempDir("tree-guard-wt-"), "tip"));
    const path = await checkout.ensure({ commit, head });
    expect(readFileSync(join(path, "a.py"), "utf8")).toBe("print(2)\n");
    expect(readFileSync(join(path, "SYNTHETIC_new.py"), "utf8")).toBe("n\n");
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: path, encoding: "utf8" });
    expect(status).toMatch(/ M a\.py/);
    expect(status).toMatch(/\?\? SYNTHETIC_new\.py/);
    // The source's index and branch are as they were.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" })).toBe(
      statusBefore,
    );
    expect(await git.head()).toBe(head);

    writeFileSync(join(path, "stray.txt"), "s");
    expect(await checkout.reset()).toBe(true);
    expect(existsSync(join(path, "stray.txt"))).toBe(false);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: path, encoding: "utf8" })).toBe(
      status,
    );

    await checkout.dispose();
    expect(existsSync(path)).toBe(false);
    expect(execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" })).not.toContain(
      path,
    );
  });

  it("takes HEAD itself as the snapshot of a clean tree", async () => {
    const dir = repo();
    const git = new Git(runner, dir);
    expect(await git.snapshotWorktree(join(tempDir("tree-guard-idx-"), "index"))).toBe(
      await git.head(),
    );
  });
});
