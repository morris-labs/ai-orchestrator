// The role table's values: the vendors for each role, and how they compare
// with a profile's defaults.
import {
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

export function sameDraft(a: RoleDraft, b: RoleDraft): boolean {
  return RoleSchema.options.every((r) => sameVendors(a[r], b[r]));
}

/** The roles of a draft that differ from the base, in the shape of a run request's `roles`. */
export function roleOverrides(draft: RoleDraft, base: RoleDraft): RoleOverrides {
  const out: RoleOverrides = {};
  for (const role of RoleSchema.options) {
    if (sameVendors(draft[role], base[role])) continue;
    if (role === "reviewer") out.reviewer = [...draft.reviewer];
    else if (draft[role][0]) out[role] = draft[role][0];
  }
  return out;
}
