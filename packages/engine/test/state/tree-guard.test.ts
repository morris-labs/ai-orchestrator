import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessRunner } from "../../src/range/exec.js";
import {
  ReadOnlyViolation,
  TreeGuard,
  describeTreeChange,
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
  it("passes a call that changes nothing", async () => {
    const dir = repo();
    const guard = new TreeGuard({ runner, repoPath: dir, ignore: [] });
    await expect(guard.run(async () => 42)).resolves.toBe(42);
  });

  it("fails a call that edits a clean tree and restores it", async () => {
    const dir = repo();
    const guard = new TreeGuard({ runner, repoPath: dir, ignore: [] });
    const err = await guard
      .run(async () => {
        writeFileSync(join(dir, "a.py"), "print('edited')\n");
        writeFileSync(join(dir, "stray.txt"), "s");
        execFileSync(
          "git",
          ["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qam", "x"],
          { cwd: dir },
        );
        return "answer";
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadOnlyViolation);
    expect((err as ReadOnlyViolation).restored).toBe(true);
    expect((err as Error).message).toMatch(/HEAD moved/);
    expect(readFileSync(join(dir, "a.py"), "utf8")).toBe("print(1)\n");
    expect(existsSync(join(dir, "stray.txt"))).toBe(false);
  });

  it("doesn't restore a tree that was dirty before the call", async () => {
    const dir = repo();
    writeFileSync(join(dir, "mine.txt"), "work in progress");
    const guard = new TreeGuard({ runner, repoPath: dir, ignore: [] });
    const err = (await guard
      .run(async () => {
        writeFileSync(join(dir, "a.py"), "print('edited')\n");
      })
      .catch((e: unknown) => e)) as ReadOnlyViolation;
    expect(err.restored).toBe(false);
    expect(err.message).toMatch(/couldn't restore it safely/);
    expect(readFileSync(join(dir, "mine.txt"), "utf8")).toBe("work in progress");
  });

  it("keeps a failed call's own error and still restores the tree", async () => {
    const dir = repo();
    const guard = new TreeGuard({ runner, repoPath: dir, ignore: [] });
    const notes: string[] = [];
    await expect(
      guard.run(
        async () => {
          writeFileSync(join(dir, "stray.txt"), "s");
          throw new Error("the CLI crashed");
        },
        (m) => notes.push(m),
      ),
    ).rejects.toThrow("the CLI crashed");
    expect(existsSync(join(dir, "stray.txt"))).toBe(false);
    expect(notes[0]).toMatch(/stray\.txt/);
  });

  it("compares overlapping calls against one baseline", async () => {
    const dir = repo();
    const guard = new TreeGuard({ runner, repoPath: dir, ignore: [] });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = guard.run(async () => {
      await gate;
      return "slow";
    });
    const writer = guard.run(async () => {
      writeFileSync(join(dir, "stray.txt"), "s");
    });
    await expect(writer).rejects.toBeInstanceOf(ReadOnlyViolation);
    release();
    await expect(slow).resolves.toBe("slow");
  });
});
