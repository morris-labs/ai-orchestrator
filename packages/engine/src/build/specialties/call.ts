// Marks a build agent call with its task's specialties.
import type { PlacedCallSpec } from "../placements/index.js";
import type { SpecialtyPack } from "./load.js";

/**
 * Names the task's specialties on a call, so its lease, its agent events,
 * and its settlement count toward each one, and adds the folder of each
 * account skill to the directories the agent can read, so it can open the
 * files the guidance refers to. A repository specialty's folder is already
 * in the worktree. The prompt itself gets the text from `rolePrompt()`.
 */
export function specialtyCall<T extends PlacedCallSpec>(
  spec: T,
  packs: ReadonlyArray<Pick<SpecialtyPack, "name" | "source" | "dir">>,
): T {
  if (packs.length === 0) return spec;
  const dirs = packs.filter((pack) => pack.source === "account").map((pack) => pack.dir);
  const extraDirs = [...new Set([...(spec.request.extraDirs ?? []), ...dirs])];
  return {
    ...spec,
    specialties: packs.map((pack) => pack.name),
    request: { ...spec.request, ...(extraDirs.length > 0 ? { extraDirs } : {}) },
  };
}
