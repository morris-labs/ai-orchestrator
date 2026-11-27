// The build pipeline: the steps a build runs, in order, and the handler of
// each. A step in the pipeline without a handler is one this engine version
// doesn't run yet: the build pauses there with a note.
import type { BuildFlow, BuildStep } from "@aio/contracts";
import { runContracts } from "./contracts.js";
import { runPreflight } from "./preflight.js";
import { runReleaseReady } from "./release-ready.js";
import { runReview } from "./review.js";
import { runTasks } from "./tasks.js";
import { runTestsFirst } from "./tests-first.js";
import type { StepHandler } from "./types.js";

export {
  CONTRACTS_SEAT,
  contractFiles,
  contractsAttemptFile,
  runsContracts,
  type ContractsAttempt,
} from "./contracts.js";
export {
  COVERAGE_CHECKER,
  COVERAGE_REPORT_FILE,
  type CoverageGap,
  type CoverageReport,
} from "./coverage-check.js";
export { PREFLIGHT_RUNS, type PreflightRecord } from "./preflight.js";
export { RELEASE_FILES, SCRIBE } from "./release-ready.js";
export { REVIEW_FIXER_SEAT, REVIEW_POLL_MS, reviewTaskContext } from "./review.js";
export { ATTEMPT_CAP, type AttemptRecord } from "./tasks.js";
export type { StepHandler, StepOutcome } from "./types.js";
export { TESTS_FIRST_ROUND_CAP, TEST_ENGINEER, type RoundRecord } from "./tests-first.js";

/** The steps a build runs, in order. */
export const BUILD_PIPELINE: readonly BuildStep[] = [
  "preflight",
  "contracts",
  "tests_first",
  "tasks",
  "review",
  "release_ready",
];

/**
 * The steps that the single-session flow skips: one Developer session works
 * against the criteria, with no contracts or tests written first.
 */
export const SINGLE_SESSION_SKIPS: readonly BuildStep[] = ["contracts", "tests_first"];

/**
 * The steps of `steps` that a build with `flow` runs, in order. A plan
 * without a flow runs as a pipeline build.
 */
export function stepsForFlow(
  steps: readonly BuildStep[],
  flow: BuildFlow | null | undefined,
): BuildStep[] {
  if (flow !== "single_session") return [...steps];
  return steps.filter((step) => !SINGLE_SESSION_SKIPS.includes(step));
}

/** The handler of each step that this engine version runs. */
export const STEP_HANDLERS: Partial<Record<BuildStep, StepHandler>> = {
  preflight: runPreflight,
  contracts: runContracts,
  tests_first: runTestsFirst,
  tasks: runTasks,
  review: runReview,
  release_ready: runReleaseReady,
};
