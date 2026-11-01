// The run launcher's form and its conversion into a `RunRequest`.
import {
  RunRequestSchema,
  defaultContainerPath,
  type Box,
  type Pipeline,
  type Profile,
  type RunRequest,
} from "@aio/contracts";

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
  readOnly: false,
  includeWorktree: false,
  roundCap: "25",
};

/**
 * Prefills the form from a box: its project, worktree, and branch. The
 * engine runs in the container, so the repository is the container path:
 * the box view's `containerWorkDir` when the server sends it, else the
 * host path mapped by its shape (the same path except on Windows).
 */
export function formFromBox(form: LauncherForm, box: Box, containerWorkDir?: string): LauncherForm {
  return {
    ...form,
    projectId: box.projectId,
    boxId: box.id,
    repoPath: containerWorkDir ?? defaultContainerPath(box.worktree ?? box.targetDir),
    tip: box.branch ?? form.tip,
  };
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
  if (errors.length > 0) return { ok: false, errors };
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
