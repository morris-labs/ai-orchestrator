// The build pipeline: the steps a build runs, in order, and the handler of
// each. A step in the pipeline without a handler is one this engine version
// doesn't run yet: the build pauses there with a note. Later milestones add
// the release ready handler.
import type { BuildStep } from "@aio/contracts";
import { runPreflight } from "./preflight.js";
import { runReview } from "./review.js";
import { runTasks } from "./tasks.js";
import { runTestsFirst } from "./tests-first.js";
import type { StepHandler } from "./types.js";

export {
  COVERAGE_CHECKER,
  COVERAGE_REPORT_FILE,
  type CoverageGap,
  type CoverageReport,
} from "./coverage-check.js";
export { PREFLIGHT_RUNS, type PreflightRecord } from "./preflight.js";
export { REVIEW_FIXER_SEAT, REVIEW_POLL_MS, reviewTaskContext } from "./review.js";
export { ATTEMPT_CAP, type AttemptRecord } from "./tasks.js";
export type { StepHandler, StepOutcome } from "./types.js";
export { TESTS_FIRST_ROUND_CAP, TEST_ENGINEER, type RoundRecord } from "./tests-first.js";

/** The steps a build runs, in order. */
export const BUILD_PIPELINE: readonly BuildStep[] = [
  "preflight",
  "tests_first",
  "tasks",
  "review",
  "release_ready",
];

/** The handler of each step that this engine version runs. */
export const STEP_HANDLERS: Partial<Record<BuildStep, StepHandler>> = {
  preflight: runPreflight,
  tests_first: runTestsFirst,
  tasks: runTasks,
  review: runReview,
};
