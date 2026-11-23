// The shape of a build step.
import type { BuildContext } from "../context.js";

/**
 * What a step's run ended with: `"next"` moves the build to the next step,
 * and `"wait"` leaves it where it is because the step set a waiting status,
 * such as an escalation.
 */
export type StepOutcome = "next" | "wait";

/** Runs one step of a build. A step must be safe to run again after a restart. */
export type StepHandler = (ctx: BuildContext) => Promise<StepOutcome>;
