// The checks a build plan must pass before a freeze or a start: every task's
// role has a role file, every specialty a task names exists, and no seat's
// placement breaks the single-vendor setting.
import type { BuildPlan, RoleDefinition } from "@aio/contracts";
import { EngineError } from "../api/core-interface.js";
import {
  checkPlanSpecialties,
  SpecialtyPlanError,
  type SpecialtySources,
} from "./specialties/index.js";

/**
 * Throws `EngineError` `validation` when `plan` names a role or a specialty
 * that doesn't exist, or places a seat on a vendor that its single-vendor
 * setting excludes: that seat could never be placed.
 */
export async function checkPlan(
  plan: Pick<BuildPlan, "tasks"> & Partial<Pick<BuildPlan, "singleVendor" | "placements">>,
  roles: ReadonlyMap<string, RoleDefinition>,
  sources: SpecialtySources,
): Promise<void> {
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
