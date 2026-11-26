// The build pipeline's execution in the engine: the build controller, its
// files, the task gate, and the build requests. See
// `docs/build-pipeline/design.md` and ADR 0007.
export { BuildController, type BuildLocation, type BuildPipeline } from "./controller.js";
export {
  BuildContext,
  agentRoleFor,
  type BuildServices,
  type ReviewRuns,
  type SeatCall,
} from "./context.js";
export { escalationForCallError, type EscalationDraft } from "./escalations.js";
export { outsideWritable, runTaskGate, type TaskGateResult } from "./gate.js";
export {
  EngineBuildManager,
  createBuildManager,
  type BuildManager,
  type BuildManagerDeps,
} from "./manager.js";
export { renderStatus } from "./status-file.js";
export { BUILD_PIPELINE, STEP_HANDLERS, ATTEMPT_CAP, type StepHandler } from "./steps/index.js";
export { BuildNotFoundError, BuildStore, listBuildSlugs } from "./store.js";
export { BuildWorktree, WORKTREES_DIR, WorktreeConflict } from "./worktree.js";
