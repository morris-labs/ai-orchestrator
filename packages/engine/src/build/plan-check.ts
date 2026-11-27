// The checks a build plan must pass before a freeze or a start: the plan
// keeps to its size's task limit, unless a version before the limit froze it, every task's role has a role file, every
// specialty a task names exists, and no seat's placement breaks the
// single-vendor setting.
import { TASK_LIMITS, taskLimitText, type BuildPlan, type RoleDefinition } from "@aio/contracts";
import { EngineError } from "../api/core-interface.js";
import {
  checkPlanSpecialties,
  SpecialtyPlanError,
  type SpecialtySources,
} from "./specialties/index.js";

/**
 * Throws `EngineError` `validation` when `plan` has more tasks than its
 * size allows, names a role or a specialty that doesn't exist, or places a
 * seat on a vendor that its single-vendor setting excludes: that seat could
 * never be placed. With `taskLimit` `false`, for a plan that a version before
 * the task limit froze, it skips the task limit.
 */
export async function checkPlan(
  plan: Pick<BuildPlan, "tasks"> & Partial<Pick<BuildPlan, "size" | "singleVendor" | "placements">>,
  roles: ReadonlyMap<string, RoleDefinition>,
  sources: SpecialtySources,
  { taskLimit = true }: { taskLimit?: boolean } = {},
): Promise<void> {
  const size = plan.size ?? "medium";
  const limit = TASK_LIMITS[size];
  if (taskLimit && limit !== null && plan.tasks.length > limit) {
    throw new EngineError(
      "validation",
      `The build plan has ${plan.tasks.length} tasks, but ${taskLimitText(size)}. The Contracts step doesn't count as a task. Merge tasks until ${limit} or fewer remain, or change the plan's size.`,
    );
  }
  const single = plan.singleVendor ?? null;
  for (const [seat, placement] of Object.entries(plan.placements ?? {})) {
    if (single && placement.vendor !== undefined && placement.vendor !== single) {
      throw new EngineError(
        "validation",
        `The build plan sets placements.${seat}.vendor to ${placement.vendor}, but its singleVendor setting is ${single}. Remove placements.${seat}.vendor, set it to ${single}, or set singleVendor to null.`,
      );
    }
  }
  for (const task of plan.tasks) {
    if (!roles.has(task.role)) {
      throw new EngineError(
        "validation",
        `Task ${task.id} names the role ${task.role}, which no role file defines.`,
      );
    }
  }
  try {
    await checkPlanSpecialties(plan.tasks, sources);
  } catch (error) {
    if (error instanceof SpecialtyPlanError) throw new EngineError("validation", error.message);
    throw error;
  }
}
