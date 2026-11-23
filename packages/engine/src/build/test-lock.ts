// The test lock: the engine's record of each test file's hash after the red
// check passed. The task gate fails a Developer attempt that changes a
// locked file. A Developer can still add test files of its own.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ListedTest } from "./red-check.js";
import type { BuildStore } from "./store.js";
import type { BuildWorktree } from "./worktree.js";

/** The lock file, relative to the build directory. */
export const TEST_LOCK_FILE = "test-lock.json";

export interface LockedFile {
  /** Repository-relative path. */
  path: string;
  /** The SHA-256 of the file's content, in hex. */
  sha256: string;
}

/** The test lock, as `test-lock.json` saves it. */
export interface TestLock {
  /** The build branch commit that holds the locked files. */
  commit: string;
  /** The red check round that passed, relative to the build directory. */
  redCheck: string;
  files: LockedFile[];
  /** The tests the lock covers, each with its criterion. */
  tests: ListedTest[];
  lockedAt: string;
}

/** The test lock check: the locked files whose content differs from the lock. */
export interface LockCheck {
  passed: boolean;
  changed: string[];
}

async function fileHash(worktree: BuildWorktree, path: string): Promise<string | null> {
  try {
    return createHash("sha256")
      .update(await readFile(join(worktree.path, path)))
      .digest("hex");
  } catch {
    return null;
  }
}

/** Hashes `paths` in the worktree; a file that doesn't exist is left out. */
export async function lockFiles(
  worktree: BuildWorktree,
  paths: readonly string[],
): Promise<LockedFile[]> {
  const files: LockedFile[] = [];
  for (const path of [...new Set(paths)].sort()) {
    const sha256 = await fileHash(worktree, path);
    if (sha256 !== null) files.push({ path, sha256 });
  }
  return files;
}

/** Compares each locked file in the worktree with its hash. A deleted file counts as changed. */
export async function checkLock(worktree: BuildWorktree, lock: TestLock): Promise<LockCheck> {
  const changed: string[] = [];
  for (const file of lock.files) {
    if ((await fileHash(worktree, file.path)) !== file.sha256) changed.push(file.path);
  }
  return { passed: changed.length === 0, changed };
}

/** The build's test lock, or `null` before tests first locked any test. */
export async function readTestLock(store: BuildStore): Promise<TestLock | null> {
  return (await store.readJson<TestLock>(store.path(TEST_LOCK_FILE))) ?? null;
}

export function writeTestLock(store: BuildStore, lock: TestLock): Promise<void> {
  return store.writeJson(store.path(TEST_LOCK_FILE), lock);
}
