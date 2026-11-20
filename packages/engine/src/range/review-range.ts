import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileGroupSchema,
  STANDARD_GROUP_SIZE_LIMIT,
  runDepth,
  type PolicyFile,
  type RunRequest,
  type RunDepth,
} from "@aio/contracts";
import { z } from "zod";
import { selectFiles } from "../group/exclude.js";
import { groupFiles } from "../group/group.js";
import { assignTiers } from "../group/signals.js";
import { parseDiff, type DiffFile } from "./diff.js";
import type { Git } from "./git.js";
import type { ResolvedRange } from "./resolve.js";

/** The saved commits, snapshot, and selected files for one round and tip. */
export const ReviewRangeSchema = z.object({
  key: z.string(),
  round: z.number().int().nonnegative(),
  namedBaseSha: z.string(),
  changeBase: z.string(),
  branchDiffBase: z.string(),
  branchPoint: z.string().nullable(),
  branchPointCheckout: z.object({ commit: z.string(), head: z.string() }).nullable(),
  tipSha: z.string(),
  tipCommit: z.string(),
  worktree: z.boolean(),
  linesAt: z.string(),
  promptRange: z.object({
    repoPath: z.string(),
    baseSha: z.string(),
    tipSha: z.string(),
    tipRef: z.string().nullable(),
    wholeProject: z.boolean().optional(),
  }),
  fixRange: z.object({ baseSha: z.string(), tipSha: z.string() }).nullable(),
  tipCheckout: z.object({ commit: z.string(), head: z.string() }),
  wholeProject: z.boolean(),
  fixDiffOnly: z.boolean(),
  files: z.array(z.custom<DiffFile>()),
  excluded: z.array(z.object({ path: z.string(), source: z.enum(["built-in", "policy", "run"]) })),
  groups: z.array(FileGroupSchema),
  grouped: z.boolean(),
});
export type ReviewRange = z.infer<typeof ReviewRangeSchema>;
export type ReviewRangeRequest = Pick<
  RunRequest,
  "repoPath" | "scope" | "modelTier" | "excludePaths" | "includeWorktree" | "exactBase"
> & { depth?: RunDepth | undefined };

/** Inputs shared by a saved run and its unsaved preview. */
export interface ReviewRangeInput {
  git: Git;
  resolved: ResolvedRange;
  request: ReviewRangeRequest;
  policy: PolicyFile;
  round?: number;
  tipSha?: string;
  reviewedFrom?: string | null;
  preFixSha?: string | null;
  groupSizeLimit?: number;
  now?: () => number;
  saved?: ReviewRange | null;
}

/** Gets the stable key used by grouping before round 1 and by round stages. */
export function reviewRangeKey(
  round: number,
  tip: string,
  worktree: boolean,
  namedBase: string,
  changeBase: string,
): string {
  return `${Math.max(1, round)}:${tip}:${worktree}:${namedBase}:${changeBase}`;
}

/** Selects the round's commits without reading a working tree or saving a run. */
export function reviewRangeSeed(input: Omit<ReviewRangeInput, "git" | "policy">): ReviewRange {
  const { resolved, request } = input;
  const round = Math.max(1, input.round ?? 1);
  const tip = input.tipSha ?? resolved.tipSha;
  const worktree = request.includeWorktree && resolved.includeWorktree && round === 1;
  const fixDiffOnly =
    (runDepth(request) === "standard" || request.scope === "whole") &&
    round > 1 &&
    !!input.reviewedFrom;
  const changeBase = fixDiffOnly ? input.reviewedFrom! : resolved.diffBaseSha;
  return {
    key: reviewRangeKey(round, tip, worktree, resolved.baseSha, changeBase),
    round,
    namedBaseSha: resolved.baseSha,
    changeBase,
    branchDiffBase: resolved.diffBaseSha,
    fixRange: input.preFixSha ? { baseSha: input.preFixSha, tipSha: tip } : null,
    branchPoint: request.scope === "whole" ? null : resolved.diffBaseSha,
    branchPointCheckout:
      request.scope === "whole"
        ? null
        : { commit: resolved.diffBaseSha, head: resolved.diffBaseSha },
    tipSha: tip,
    tipCommit: tip,
    worktree,
    linesAt: tip,
    promptRange: {
      repoPath: request.repoPath,
      baseSha: changeBase,
      tipSha: tip,
      tipRef: resolved.tipRef,
      ...(request.scope === "whole" && !fixDiffOnly ? { wholeProject: true } : {}),
    },
    tipCheckout: { commit: tip, head: tip },
    wholeProject: request.scope === "whole" && !fixDiffOnly,
    fixDiffOnly,
    files: [],
    excluded: [],
    groups: [],
    grouped: false,
  };
}

/** Resolves the shared snapshot and groups without writing saved run state. */
export async function resolveReviewRange(input: ReviewRangeInput): Promise<ReviewRange> {
  const { git, request, policy } = input;
  const seed = reviewRangeSeed(input);
  const saved = input.saved?.key === seed.key ? input.saved : null;
  if (
    saved?.worktree &&
    saved.tipCommit !== saved.tipSha &&
    !(await git.tryRevParse(saved.tipCommit))
  ) {
    throw new Error(
      `The saved working-tree snapshot ${saved.tipCommit} is missing. Restore the Git objects or start another review.`,
    );
  }
  if (saved?.grouped) return { ...saved, fixRange: seed.fixRange };
  const range = saved ?? seed;
  range.branchPoint =
    request.scope === "whole"
      ? null
      : request.exactBase
        ? input.resolved.baseSha
        : input.saved?.namedBaseSha === input.resolved.baseSha && input.saved.branchPoint
          ? input.saved.branchPoint
          : (await git.ok(["merge-base", input.resolved.baseSha, input.resolved.tipSha]))
            ? await git.mergeBase(input.resolved.baseSha, input.resolved.tipSha)
            : null;
  range.branchPointCheckout = range.branchPoint
    ? { commit: range.branchPoint, head: range.branchPoint }
    : null;
  if (range.worktree && (!saved || saved.tipCommit === saved.tipSha)) {
    const head = await git.head();
    const commit = await git.snapshotWorktree(join(tmpdir(), `aio-index-range-${randomUUID()}`));
    range.tipCommit = commit;
    range.promptRange.tipSha = commit;
    range.tipCheckout = { commit, head };
    range.linesAt = `worktree:${range.tipSha}:${commit}`;
  }
  if (request.scope === "whole") await git.emptyBaseCommit();
  const { files, excluded } = selectFiles(
    range.wholeProject
      ? await git.addedFiles(range.changeBase, range.tipCommit)
      : parseDiff(await git.diff(range.changeBase, range.tipCommit)),
    request,
    policy,
  );
  const depth = runDepth(request);
  let groups = await groupFiles(files, {
    policy,
    readFile: (file) => git.show(range.tipCommit, file),
    ...(depth === "standard"
      ? { coarse: true, sizeLimit: input.groupSizeLimit ?? STANDARD_GROUP_SIZE_LIMIT }
      : {}),
  });
  if (request.modelTier) {
    groups = await assignTiers(groups, files, {
      git,
      policy,
      diffBase: range.changeBase,
      tip: range.tipCommit,
      choice: request.modelTier,
      depth,
      skipHistory: range.wholeProject,
      ...(input.now ? { now: input.now } : {}),
    });
  }
  return { ...range, files, excluded, groups, grouped: true };
}
