// Which actions are enabled for the current selection: the rules of the Qt
// app's `updateActionStates()` (inventory section 1.4), adapted to 1.0.0,
// where every box has a record and there is no "exited" state.
import type { BoxView } from "@aio/contracts";

export type ActionId =
  | "edit"
  | "fork"
  | "convertToWorktree"
  | "purge"
  | "moveWorkDir"
  | "changeWorkDir"
  | "openShell"
  | "attach"
  | "start"
  | "stop"
  | "restartAll"
  | "remove"
  | "stopAll"
  | "startAllStopped"
  | "closeTab"
  | "startReview";

export type ActionStates = Record<ActionId, boolean>;

/**
 * Computes the enabled state of every action.
 *
 * @param selection the selected rows.
 * @param all every row, whatever the filter shows: Restart All, Stop All, and Start All
 *   Stopped look at the whole model.
 * @param tabCount open terminal tabs.
 */
export function actionStates(
  selection: readonly BoxView[],
  all: readonly BoxView[],
  tabCount: number,
): ActionStates {
  // A Starting or Stopping row counts for nothing (inventory 1.4) in the
  // running and stopped flags and the actions that move or convert a box.
  // Edit, Fork, and Purge apply to any single row, as in the Qt app.
  const only = selection.length === 1 ? (selection[0] as BoxView) : null;
  const single = only && only.status !== "starting" && only.status !== "stopping" ? only : null;
  const anyRunning = selection.some((b) => b.status === "running");
  const runningExists = all.some((b) => b.status === "running");
  const anyStopped = selection.some((b) => b.status === "stopped");
  const hasWorktree = single?.box.worktree !== undefined;
  const singleRunning = single?.status === "running";
  const canRelocate = single !== null && !hasWorktree && !singleRunning;
  const underReview = single?.reviewState.state === "under_review";

  return {
    edit: only !== null,
    fork: only !== null && only.box.sessionUuid !== null,
    convertToWorktree:
      single !== null && single.box.workspace !== undefined && !hasWorktree && !singleRunning,
    purge: only !== null && only.box.targetDir !== "",
    moveWorkDir: canRelocate && single.box.targetDir !== "",
    changeWorkDir: canRelocate,
    openShell: singleRunning,
    attach: singleRunning,
    start: anyStopped,
    stop: anyRunning,
    restartAll: runningExists,
    remove: anyStopped && !anyRunning,
    stopAll: runningExists,
    startAllStopped: all.some((b) => b.status === "stopped" && b.box.wasRunning),
    closeTab: tabCount > 0,
    startReview: single !== null && !underReview,
  };
}
