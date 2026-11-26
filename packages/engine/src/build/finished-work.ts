// Finished work of other tasks in a task's changes. Tasks share one
// worktree, and a task keeps its base while other tasks finish ahead of it,
// for example after an escalation resolved before the engine set it aside.
// Every path that changed since that base then includes their work, and a
// gate that put "outside" paths back to the base, or a set-aside that saved
// and reverted the task's changes, would undo finished tasks.
import type { BuildWorktree } from "./worktree.js";

/** A finished task's range of commits: its base and its last commit. */
export interface FinishedTask {
  base?: string | null;
  commit?: string | null;
}

/**
 * The paths in `changed` that a finished task changed and whose content in
 * the worktree matches the newest finished task's commit: their work, not
 * the task's. Tasks without a base or a commit on the branch are skipped.
 */
export async function finishedWork(
  worktree: BuildWorktree,
  changed: readonly string[],
  done: readonly FinishedTask[],
): Promise<string[]> {
  let newest: string | undefined;
  const touched = new Set<string>();
  for (const { base, commit } of done) {
    if (!base || !commit) continue;
    if (!(await worktree.git.ok(["merge-base", "--is-ancestor", commit, "HEAD"]))) continue;
    for (const path of await worktree.changedBetween(base, commit)) touched.add(path);
    if (!newest || (await worktree.git.ok(["merge-base", "--is-ancestor", newest, commit]))) {
      newest = commit;
    }
  }
  const candidates = changed.filter((p) => touched.has(p));
  if (!newest || candidates.length === 0) return [];
  return worktree.matching(newest, candidates);
}
