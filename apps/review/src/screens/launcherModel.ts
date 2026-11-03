// The run launcher's form and its conversion into a `RunRequest`.
import {
  RunRequestSchema,
  type Box,
  type ModelTierChoice,
  type Pipeline,
  type Profile,
  type Role,
  type RunDepth,
  type RunRequest,
  type Severity,
  type Vendor,
} from "@aio/contracts";
import {
  followsProfile,
  profileDraft,
  roleOverrides,
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
   * Only the roles a person edited, or `null` when every role follows the
   * profile. A role left out follows the profile from round to round.
   */
  roles: Partial<RoleDraft> | null;
  /** When true, a vendor never disproves its own findings or confirms its own fixes. */
  crossVendor: boolean;
  modelTier: ModelTierChoice;
  /** `default` takes the depth's floor; `all` checks every severity. */
  verifyFloor: Severity | "all" | "default";
  depth: RunDepth;
  readOnly: boolean;
  includeWorktree: boolean;
  /** Empty takes the depth's round cap. */
  roundCap: string;
}

/** The choices of a verification floor control, from checking everything to the least. */
export const VERIFY_FLOOR_OPTIONS: ReadonlyArray<{ value: Severity | "all"; label: string }> = [
  { value: "all", label: "All severities" },
  { value: "nit", label: "nit and above" },
  { value: "P3", label: "P3 and above" },
  { value: "P2", label: "P2 and above" },
  { value: "P1", label: "P1 only" },
];

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
  crossVendor: true,
  modelTier: "auto",
  verifyFloor: "default",
  depth: "standard",
  readOnly: false,
  includeWorktree: false,
  roundCap: "",
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

/** The roles the role table shows: the person's edits over the profile's round 1 roles. */
export function formRoles(form: LauncherForm): RoleDraft {
  return { ...profileDraft(form.profile), ...form.roles };
}

/** Keeps the edits that differ from what the profile gives in every round. */
function withEdits(form: LauncherForm, edits: Partial<RoleDraft>): LauncherForm {
  const kept = Object.entries(edits).filter(
    ([role, vendors]) => !followsProfile(form.profile, role as Role, vendors),
  );
  return {
    ...form,
    roles: kept.length > 0 ? (Object.fromEntries(kept) as Partial<RoleDraft>) : null,
  };
}

/** Gives a role to vendors in the form. */
export function setFormRole(form: LauncherForm, role: Role, vendors: Vendor[]): LauncherForm {
  return withEdits(form, { ...form.roles, [role]: vendors });
}

/**
 * Switches the profile. Roles a person edited stay; every other role follows
 * the new profile.
 */
export function setFormProfile(form: LauncherForm, profile: Profile): LauncherForm {
  return withEdits({ ...form, profile }, form.roles ?? {});
}

export type BuildResult = { ok: true; request: RunRequest } | { ok: false; errors: string[] };

/** Validates the form and builds the request body; lists every problem at once. */
export function buildRunRequest(form: LauncherForm): BuildResult {
  const errors: string[] = [];
  if (!form.projectId) errors.push("Select a container.");
  if (!form.repoPath) errors.push("Select a repository.");
  if (!form.base.trim()) errors.push("Select a base.");
  const roundCap = form.roundCap.trim() === "" ? undefined : Number(form.roundCap);
  if (roundCap !== undefined && (!Number.isInteger(roundCap) || roundCap < 1))
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
  // Only the roles a person edited go with the request; the others keep
  // following the profile from round to round. A read-only run has no fix
  // stage, so its fixer and confirmer choices don't apply.
  const { fixer: _fixer, confirmer: _confirmer, ...kept } = form.roles ?? {};
  const overrides = roleOverrides(form.readOnly ? kept : (form.roles ?? {}));
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
    modelTier: form.modelTier,
    depth: form.depth,
    // No severity ranks below `nit`, so that floor checks everything.
    ...(form.verifyFloor === "default"
      ? {}
      : { verifyFloor: form.verifyFloor === "all" ? "nit" : form.verifyFloor }),
    crossVendor: form.crossVendor,
    readOnly: form.readOnly,
    includeWorktree: form.includeWorktree,
    ...(roundCap !== undefined ? { roundCap } : {}),
  });
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  return { ok: true, request: parsed.data };
}
