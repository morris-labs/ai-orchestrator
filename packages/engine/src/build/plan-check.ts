// The checks a build plan must pass before a freeze or a start: every task's
// role has a role file, and every specialty a task names exists.
import type { BuildPlan, RoleDefinition } from "@aio/contracts";
import { EngineError } from "../api/core-interface.js";
import {
  checkPlanSpecialties,
  SpecialtyPlanError,
  type SpecialtySources,
} from "./specialties/index.js";

/** Throws `EngineError` `validation` when `plan` names a role or a specialty that doesn't exist. */
export async function checkPlan(
  plan: Pick<BuildPlan, "tasks">,
  roles: ReadonlyMap<string, RoleDefinition>,
  sources: SpecialtySources,
): Promise<void> {
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
