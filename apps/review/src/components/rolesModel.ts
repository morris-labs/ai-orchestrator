// The role table's values: the vendors for each role, and how they compare
// with a profile's defaults.
import {
  BALANCED_CLAUDE_ROUNDS,
  RoleSchema,
  profileRoles,
  type Profile,
  type Role,
  type RoleAssignment,
  type RoleOverrides,
  type Vendor,
} from "@aio/contracts";

/** The vendors chosen for each role; `reviewer` can hold several, the others one. */
export type RoleDraft = Record<Role, Vendor[]>;

/** Only `reviewer` takes more than one vendor. */
export function isMultiVendor(role: Role): boolean {
  return role === "reviewer";
}

export function draftFromRoles(roles: RoleAssignment): RoleDraft {
  return Object.fromEntries(
    RoleSchema.options.map((r) => {
      const v = roles[r];
      return [r, Array.isArray(v) ? [...v] : [v]];
    }),
  ) as RoleDraft;
}

/** The roles a profile starts a run with: its round 1 roles. */
export function profileDraft(profile: Profile): RoleDraft {
  return draftFromRoles(profileRoles(profile, 1));
}

/** True when two vendor lists hold the same vendors, in any order. */
export function sameVendors(a: readonly Vendor[], b: readonly Vendor[]): boolean {
  return [...a].sort().join() === [...b].sort().join();
}

/**
 * True when `vendors` is what the profile gives `role` in every round. A
 * choice that matches only round 1, such as Claude reviewing under `balanced`,
 * is still a choice: without an override the profile drops it later.
 */
export function followsProfile(profile: Profile, role: Role, vendors: readonly Vendor[]): boolean {
  return [1, BALANCED_CLAUDE_ROUNDS + 1].every((round) => {
    const value = profileRoles(profile, round)[role];
    return sameVendors(vendors, Array.isArray(value) ? value : [value]);
  });
}

/** The roles a person chose, in the shape of a run request's `roles`. */
export function roleOverrides(edits: Partial<RoleDraft>): RoleOverrides {
  const out: RoleOverrides = {};
  for (const role of RoleSchema.options) {
    const vendors = edits[role];
    if (!vendors) continue;
    if (role === "reviewer") out.reviewer = [...vendors];
    else if (vendors[0]) out[role] = vendors[0];
  }
  return out;
}

/** What the engine will replace in a draft, for a warning next to the table. */
export function roleConflicts(draft: RoleDraft, crossVendor: boolean): string[] {
  if (!crossVendor) return [];
  const out: string[] = [];
  const disprover = draft.disprover[0];
  const confirmer = draft.confirmer[0];
  if (disprover && draft.reviewer.includes(disprover)) {
    out.push(
      `With cross-vendor checks on, ${disprover} can't disprove its own findings, so another vendor disproves them.`,
    );
  }
  if (confirmer && confirmer === draft.fixer[0]) {
    out.push(
      `With cross-vendor checks on, ${confirmer} can't confirm its own fixes, so another vendor confirms them.`,
    );
  }
  return out;
}
