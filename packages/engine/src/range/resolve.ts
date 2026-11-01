// Review range resolution, as design.md "Review range" describes it.
import type { CommandRunner } from "../core.js";
import type { GitHubClient } from "../postpush/github.js";
import { Git } from "./git.js";

export interface RangeInput {
  repoPath: string;
  /** A branch, tag, or commit, or `pr` for the open pull request's base. */
  base: string;
  /** A branch, or a commit with `readOnly`. Absent means the checked-out branch. */
  tip?: string;
  mergeBase: boolean;
  exactBase: boolean;
  readOnly: boolean;
  includeWorktree: boolean;
  prNumber?: number;
}

export interface ResolvedRange {
  /** The base as given, or the pull request's base branch for `pr`. */
  baseRef: string;
  /** The base, pinned for the run. */
  baseSha: string;
  /** The branch the fixer commits to, or `null` for a commit tip. */
  tipRef: string | null;
  tipSha: string;
  /** The commit the diff starts from: the merge base, or `baseSha` with an exact base. */
  diffBaseSha: string;
  /** Uncommitted changes exist in the working tree. */
  dirty: boolean;
  /** Diff to the working tree instead of `tipSha`. */
  includeWorktree: boolean;
}

export type RangeErrorCode =
  "dirty_tree" | "bad_ref" | "tip_not_checked_out" | "sha_tip_needs_read_only" | "no_pr";

export class RangeError extends Error {
  constructor(
    readonly code: RangeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RangeError";
  }
}

const SHA_RE = /^[0-9a-f]{7,64}$/;

/**
 * Whether a `git status --porcelain` line names only paths in a
 * `.aio/` directory, the engine's own. A rename names two paths.
 */
function isEngineStatusLine(line: string): boolean {
  return line
    .slice(3)
    .split(" -> ")
    .every((p) => /(^|\/)\.aio\//.test(p.replace(/^"/, "")));
}

/**
 * Refuses a ref that starts with `-`. No branch, tag, or commit name can,
 * and `gh` or `git` would read one as an option, such as `--web`.
 */
function refuseOptionLike(what: "base" | "tip", ref: string): void {
  if (ref.startsWith("-")) {
    throw new RangeError("bad_ref", `The ${what} ${ref} starts with "-", so it isn't a ref.`);
  }
}

/** Resolves `base` to a ref, reading the pull request's base branch for `pr`. */
export async function resolveBaseRef(
  git: Git,
  input: Pick<RangeInput, "base" | "tip" | "prNumber" | "repoPath">,
  github?: GitHubClient,
): Promise<string> {
  refuseOptionLike("base", input.base);
  if (input.tip !== undefined) refuseOptionLike("tip", input.tip);
  if (input.base !== "pr") return input.base;
  if (!github)
    throw new RangeError("no_pr", "The base `pr` needs the gh CLI, which isn't configured.");
  const selector = input.prNumber ?? input.tip ?? (await git.currentBranch());
  if (selector === null || selector === undefined) {
    throw new RangeError("no_pr", "The base `pr` needs a pull request number or a tip branch.");
  }
  const pr = await github.viewPr(input.repoPath, selector);
  if (!pr) throw new RangeError("no_pr", `No pull request found for ${String(selector)}.`);
  const remote = `origin/${pr.baseRefName}`;
  return (await git.tryRevParse(remote)) ? remote : pr.baseRefName;
}

/**
 * Resolves the review range: pins the base to a SHA, resolves the tip,
 * picks the diff start, and refuses a dirty tree unless `includeWorktree`.
 */
export async function resolveRange(
  runner: CommandRunner,
  input: RangeInput,
  github?: GitHubClient,
): Promise<ResolvedRange> {
  const git = new Git(runner, input.repoPath);
  const baseRef = await resolveBaseRef(git, input, github);
  const baseSha = await git.tryRevParse(baseRef);
  if (!baseSha) throw new RangeError("bad_ref", `The base ${baseRef} doesn't name a commit.`);

  const current = await git.currentBranch();
  let tipRef: string | null;
  let tipSha: string;
  if (input.tip === undefined) {
    if (current === null && !input.readOnly) {
      throw new RangeError(
        "tip_not_checked_out",
        "HEAD is detached. Check out the branch to review, or pass a commit as the tip with read-only.",
      );
    }
    tipRef = current;
    tipSha = await git.revParse("HEAD");
  } else if (await git.isLocalBranch(input.tip)) {
    tipRef = input.tip;
    tipSha = await git.revParse(`refs/heads/${input.tip}`);
  } else {
    const sha = await git.tryRevParse(input.tip);
    if (!sha)
      throw new RangeError("bad_ref", `The tip ${input.tip} doesn't name a branch or commit.`);
    if (!input.readOnly) {
      throw new RangeError(
        "sha_tip_needs_read_only",
        `The tip ${input.tip} isn't a local branch. The fixer commits to the tip, so pass a branch, or review the commit read-only.`,
      );
    }
    tipRef = SHA_RE.test(input.tip) ? null : input.tip;
    tipSha = sha;
  }

  if (!input.readOnly && tipRef !== null && current !== tipRef) {
    throw new RangeError(
      "tip_not_checked_out",
      `The fixer commits to ${tipRef}, but ${current ?? "a detached HEAD"} is checked out in ${input.repoPath}.`,
    );
  }

  // The engine's own run files don't count, in case `info/exclude` lacks
  // `.aio/`.
  const dirty = (await git.statusLines()).some((l) => !isEngineStatusLine(l));
  if (dirty && !input.includeWorktree) {
    throw new RangeError(
      "dirty_tree",
      `The working tree in ${input.repoPath} has uncommitted changes. Commit or stash them, or include the working tree.`,
    );
  }

  const useMergeBase = input.mergeBase && !input.exactBase;
  const diffBaseSha = useMergeBase ? await git.mergeBase(baseSha, tipSha) : baseSha;
  // Uncommitted changes only make sense on the checked-out tip.
  const includeWorktree =
    input.includeWorktree && dirty && (tipRef === null ? false : current === tipRef);
  return { baseRef, baseSha, tipRef, tipSha, diffBaseSha, dirty, includeWorktree };
}
