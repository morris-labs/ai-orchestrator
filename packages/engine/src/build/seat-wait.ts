// Commits that land on the branch while a step waits for its seat. A seat
// call lets go of the worktree while it waits, and between a step's calls
// the drive doesn't change the branch, so other seats' message turns, or the
// Project manager while the build waits for a decision, can commit then. A
// step that counts its agent's changes from the step's start must leave
// those commits' paths be, or it reverts them in its own commit.
import type { BuildWorktree } from "./worktree.js";

/** A stretch of the branch's history that only other seats wrote. */
export interface SeatWait {
  /** The branch head when the step last had the worktree. */
  from: string;
  /** The branch head when the agent's turn began; unset when it never began. */
  turn?: string;
}

/** A step's call record, as far as its seat waits go. */
export interface WaitedCall {
  /** The worktree's `HEAD` when the record was made. */
  start: string;
  /** The worktree's `HEAD` when the agent's turn began. */
  turn?: string;
  /** The worktree's `HEAD` when the agent's turn ended. */
  end?: string;
}

/**
 * The seat waits of a step's calls, in order: each runs from the head where
 * the call before it ended, or from the call's own start for the first call
 * or a call saved before the engine recorded that, to its turn's start.
 */
export function seatWaits(calls: readonly WaitedCall[]): SeatWait[] {
  return calls.map((call, i) => {
    const from = calls[i - 1]?.end ?? call.start;
    return call.turn === undefined ? { from } : { from, turn: call.turn };
  });
}

/**
 * The paths that commits in `waits` changed: other seats' work, which the
 * step's agent didn't make. A wait whose turn doesn't descend from its start,
 * such as after a reset, adds nothing.
 */
export async function landedWhileWaiting(
  worktree: BuildWorktree,
  waits: readonly SeatWait[],
): Promise<string[]> {
  const paths = new Set<string>();
  for (const { from, turn } of waits) {
    if (turn === undefined || turn === from) continue;
    if (!(await worktree.git.ok(["merge-base", "--is-ancestor", from, turn]))) continue;
    for (const path of await worktree.changedBetween(from, turn)) paths.add(path);
  }
  return [...paths].sort();
}
