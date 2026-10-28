// Which actions are enabled for the current selection: the rules of the Qt
// app's `updateActionStates()` (inventory section 1.4), adapted to 4.0.0,
// where every box has a record and there is no "exited" state.
import type { BoxView } from "@agentbox/contracts";

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
 * @param all every row, whatever the filter shows: Stop All and Start All
 *   Stopped look at the whole model.
 * @param tabCount open terminal tabs.
 */
export function actionStates(
  selection: readonly BoxView[],
  all: readonly BoxView[],
  tabCount: number,
): ActionStates {
  const single = selection.length === 1 ? (selection[0] as BoxView) : null;
  const anyRunning = selection.some((b) => b.status === "running");
  const anyStopped = selection.some((b) => b.status === "stopped");
  const transitioning =
    single !== null && (single.status === "starting" || single.status === "stopping");
  const hasWorktree = single?.box.worktree !== undefined;
  const singleRunning = single?.status === "running";
  const canRelocate = single !== null && !transitioning && !hasWorktree && !singleRunning;
  const underReview = single?.reviewState.state === "under_review";

  return {
    edit: single !== null,
    fork: single !== null && single.box.sessionUuid !== null,
    convertToWorktree:
      single !== null &&
      single.box.workspace !== undefined &&
      !hasWorktree &&
      !singleRunning &&
      !transitioning,
    purge: single !== null && single.box.targetDir !== "",
    moveWorkDir: canRelocate && single.box.targetDir !== "",
    changeWorkDir: canRelocate,
    openShell: singleRunning,
    attach: singleRunning,
    start: anyStopped,
    stop: anyRunning,
    restartAll: anyRunning,
    remove: anyStopped && !anyRunning,
    stopAll: all.some((b) => b.status === "running"),
    startAllStopped: all.some((b) => b.status === "stopped" && b.box.wasRunning),
    closeTab: tabCount > 0,
    startReview: single !== null && !underReview,
  };
}
