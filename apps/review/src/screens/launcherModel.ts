// The run launcher's form and its conversion into a `RunRequest`.
import {
  RunRequestSchema,
  type Box,
  type Pipeline,
  type Profile,
  type Role,
  type RunRequest,
  type Vendor,
} from "@aio/contracts";
import {
  profileDraft,
  roleOverrides,
  sameDraft,
  type RoleDraft,
} from "../components/rolesModel.js";

export type BaseMode = "merge-base" | "exact";

export interface LauncherForm {
  projectId: string;
  boxId: string;
  repoPath: string;
  /** A branch, tag, or commit, or `pr` for the open pull request's base. */
  base: string;
  baseMode: BaseMode;
  tip: string;
  pipeline: Pipeline;
  prNumber: string;
  profile: Profile;
  /**
   * The roles a person chose, or `null` to follow the profile's defaults.
   * Holds only choices that differ from the profile's defaults.
   */
  roles: RoleDraft | null;
  readOnly: boolean;
  includeWorktree: boolean;
  roundCap: string;
}

export const DEFAULT_FORM: LauncherForm = {
  projectId: "",
  boxId: "",
  repoPath: "",
  base: "origin/main",
  baseMode: "merge-base",
  tip: "",
  pipeline: "pre-push",
  prNumber: "",
  profile: "offload",
  roles: null,
  readOnly: false,
  includeWorktree: false,
  roundCap: "25",
};

/** Prefills the form from a box: its project, worktree, and branch. */
export function formFromBox(form: LauncherForm, box: Box): LauncherForm {
  return {
    ...form,
    projectId: box.projectId,
    boxId: box.id,
    repoPath: box.worktree ?? box.targetDir,
    tip: box.branch ?? form.tip,
  };
}

/** The roles the role table shows: the person's choices, or the profile's defaults. */
export function formRoles(form: LauncherForm): RoleDraft {
  return form.roles ?? profileDraft(form.profile);
}

/** Keeps a draft only while it differs from the profile's defaults. */
function withRoles(form: LauncherForm, roles: RoleDraft): LauncherForm {
  return { ...form, roles: sameDraft(roles, profileDraft(form.profile)) ? null : roles };
}

/** Gives a role to vendors in the form. */
export function setFormRole(form: LauncherForm, role: Role, vendors: Vendor[]): LauncherForm {
  return withRoles(form, { ...formRoles(form), [role]: vendors });
}

/**
 * Switches the profile. Roles a person edited stay; otherwise the table
 * follows the new profile's defaults.
 */
export function setFormProfile(form: LauncherForm, profile: Profile): LauncherForm {
  const next = { ...form, profile };
  return form.roles ? withRoles(next, form.roles) : next;
}

export type BuildResult = { ok: true; request: RunRequest } | { ok: false; errors: string[] };

/** Validates the form and builds the request body; lists every problem at once. */
export function buildRunRequest(form: LauncherForm): BuildResult {
  const errors: string[] = [];
  if (!form.projectId) errors.push("Select a container.");
  if (!form.repoPath) errors.push("Select a repository.");
  if (!form.base.trim()) errors.push("Select a base.");
  const roundCap = Number(form.roundCap);
  if (!Number.isInteger(roundCap) || roundCap < 1)
    errors.push("The round cap must be a whole number of 1 or more.");
  let prNumber: number | undefined;
  if (form.pipeline === "post-push") {
    prNumber = Number(form.prNumber);
    if (!Number.isInteger(prNumber) || prNumber < 1)
      errors.push("A post-push run needs a pull request number.");
  }
  if (form.base.trim() === "pr" && form.pipeline === "pre-push" && !form.tip.trim()) {
    errors.push("The pull request base needs a tip branch with an open pull request.");
  }
  const draft = formRoles(form);
  if (draft.reviewer.length === 0) errors.push("Choose at least one reviewer.");
  if (errors.length > 0) return { ok: false, errors };
  // Only the roles that differ from the profile's defaults go with the
  // request; the others keep following the profile from round to round.
  const overrides = roleOverrides(draft, profileDraft(form.profile));
  const parsed = RunRequestSchema.safeParse({
    projectId: form.projectId,
    boxId: form.boxId || undefined,
    repoPath: form.repoPath,
    base: form.base.trim(),
    tip: form.tip.trim() || undefined,
    mergeBase: form.baseMode === "merge-base",
    exactBase: form.baseMode === "exact",
    pipeline: form.pipeline,
    prNumber,
    profile: form.profile,
    ...(Object.keys(overrides).length > 0 ? { roles: overrides } : {}),
    readOnly: form.readOnly,
    includeWorktree: form.includeWorktree,
    roundCap,
  });
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  return { ok: true, request: parsed.data };
}
