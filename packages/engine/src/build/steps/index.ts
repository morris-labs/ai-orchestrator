// The build pipeline: the steps a build runs, in order, and the handler of
// each. A step in the pipeline without a handler is one this engine version
// doesn't run yet: the build pauses there with a note. Later milestones add
// steps (preflight, tests first) and the release ready handler.
import type { BuildStep } from "@aio/contracts";
import { runReview } from "./review.js";
import { runTasks } from "./tasks.js";
import type { StepHandler } from "./types.js";

export { REVIEW_FIXER_SEAT, REVIEW_POLL_MS, reviewTaskContext } from "./review.js";
export { ATTEMPT_CAP, type AttemptRecord } from "./tasks.js";
export type { StepHandler, StepOutcome } from "./types.js";

/** The steps a build runs, in order. */
export const BUILD_PIPELINE: readonly BuildStep[] = ["tasks", "review", "release_ready"];

/** The handler of each step that this engine version runs. */
export const STEP_HANDLERS: Partial<Record<BuildStep, StepHandler>> = {
  tasks: runTasks,
  review: runReview,
};
