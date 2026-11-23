// The build pipeline: the steps a build runs, in order, and the handler of
// each. A step in the pipeline without a handler is one this engine version
// doesn't run yet: the build pauses there with a note. Later milestones add
// steps (preflight, release ready) and the review handler.
import type { BuildStep } from "@aio/contracts";
import { runTasks } from "./tasks.js";
import { runTestsFirst } from "./tests-first.js";
import type { StepHandler } from "./types.js";

export { ATTEMPT_CAP, type AttemptRecord } from "./tasks.js";
export type { StepHandler, StepOutcome } from "./types.js";
export { TESTS_FIRST_ROUND_CAP, TEST_ENGINEER, type RoundRecord } from "./tests-first.js";

/** The steps a build runs, in order. */
export const BUILD_PIPELINE: readonly BuildStep[] = ["tests_first", "tasks", "review"];

/** The handler of each step that this engine version runs. */
export const STEP_HANDLERS: Partial<Record<BuildStep, StepHandler>> = {
  tests_first: runTestsFirst,
  tasks: runTasks,
};
