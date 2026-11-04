// Decides which changed files a run leaves out of grouping and review.
import { WHOLE_PROJECT_EXCLUDES, type PolicyFile, type RunRequest } from "@aio/contracts";
import { matchesGlob } from "../policy/glob.js";
import type { DiffFile } from "../range/diff.js";

export type ExcludeSource = "built-in" | "policy" | "run";

export interface ExcludedFile {
  path: string;
  /** The list whose glob excludes the file. */
  source: ExcludeSource;
}

type ExcludeRequest = Pick<RunRequest, "scope" | "excludePaths">;

function excludeRules(
  request: ExcludeRequest,
  policy: PolicyFile,
): Array<{ glob: string; source: ExcludeSource }> {
  const tag = (globs: readonly string[] | undefined, source: ExcludeSource) =>
    (globs ?? []).map((glob) => ({ glob, source }));
  return [
    ...tag(request.excludePaths, "run"),
    ...tag(policy.excludePaths, "policy"),
    // The built-in list applies only when the project itself is under review.
    ...tag(request.scope === "whole" ? WHOLE_PROJECT_EXCLUDES : [], "built-in"),
  ];
}

/** True when the run can leave any file out. */
export function hasExclusions(request: ExcludeRequest, policy: PolicyFile): boolean {
  return excludeRules(request, policy).length > 0;
}

/** Splits changed files into what the run reviews and what it leaves out, in path order. */
export function selectFiles(
  all: readonly DiffFile[],
  request: ExcludeRequest,
  policy: PolicyFile,
): { files: DiffFile[]; excluded: ExcludedFile[] } {
  const rules = excludeRules(request, policy);
  const files: DiffFile[] = [];
  const excluded: ExcludedFile[] = [];
  for (const file of all) {
    const rule = rules.find((r) => matchesGlob(file.path, r.glob));
    if (rule) excluded.push({ path: file.path, source: rule.source });
    else files.push(file);
  }
  excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, excluded };
}
