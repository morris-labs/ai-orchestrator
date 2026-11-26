// Plan validation for specialties: every specialty a task names must exist.
import { SpecialtyNameSchema } from "@aio/contracts";
import { findSpecialty, type SpecialtySources } from "./load.js";

/** A task as plan validation sees it: its id and the specialties it names. */
export interface SpecialtyTask {
  id: string;
  specialties?: readonly string[];
}

/** A plan whose tasks name specialties that don't exist. */
export class SpecialtyPlanError extends Error {
  constructor(readonly unknown: ReadonlyArray<{ taskId: string; specialty: string }>) {
    const each = unknown.map((u) => `task ${u.taskId} names ${u.specialty}`).join("; ");
    super(`The plan names specialties that don't exist: ${each}.`);
    this.name = "SpecialtyPlanError";
  }
}

/**
 * Checks that every specialty each task names exists, and that each name is
 * valid. Throws `SpecialtyPlanError`, naming each unknown specialty and its
 * task, when any doesn't. Each name is looked up once.
 */
export async function checkPlanSpecialties(
  tasks: readonly SpecialtyTask[],
  sources: SpecialtySources,
): Promise<void> {
  const names = [...new Set(tasks.flatMap((task) => task.specialties ?? []))];
  const known = new Set<string>();
  await Promise.all(
    names.map(async (name) => {
      if (!SpecialtyNameSchema.safeParse(name).success) return;
      if (await findSpecialty(name, sources)) known.add(name);
    }),
  );
  const unknown = tasks.flatMap((task) =>
    (task.specialties ?? [])
      .filter((name) => !known.has(name))
      .map((specialty) => ({ taskId: task.id, specialty })),
  );
  if (unknown.length > 0) throw new SpecialtyPlanError(unknown);
}
