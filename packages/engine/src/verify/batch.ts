// Plans batched verification at the `standard` depth: which findings share one
// disprover call, and which are the same root cause as another. Pure and
// deterministic, so a plan can be saved and resumed.
import type { Effort, Finding, Vendor } from "@aio/contracts";
import { textSimilarity, titleSimilarity } from "../merge/fingerprint.js";
import { sameIssue } from "../merge/merge.js";

/** The most tokens of finding text and expected answers one disprover call carries. */
export const VERIFY_BATCH_TOKEN_LIMIT = 40_000;

/** Tokens to set aside for one finding's verdict in the answer. */
export const VERDICT_TOKEN_RESERVE = 400;

/** How similar two findings in one file must be to share a root cause at any lines. */
export const ROOT_CAUSE_SIMILARITY = 0.8;

/** The number of findings at which a batch's disprover call takes high effort. */
export const HIGH_EFFORT_BATCH_SIZE = 5;

/** The reasoning effort of a batch call, raised because many checks share one call. */
export function batchEffort(findings: number): Effort {
  return findings >= HIGH_EFFORT_BATCH_SIZE ? "high" : "medium";
}

/** Splits findings in order so that no part passes `limit` tokens, except a lone large one. */
export function splitByTokens<T>(
  items: readonly T[],
  tokensFor: (item: T) => number,
  limit = VERIFY_BATCH_TOKEN_LIMIT,
): T[][] {
  const parts: T[][] = [];
  let size = 0;
  for (const item of items) {
    const tokens = tokensFor(item) + VERDICT_TOKEN_RESERVE;
    const last = parts[parts.length - 1];
    if (last && size + tokens <= limit) {
      last.push(item);
      size += tokens;
    } else {
      parts.push([item]);
      size = tokens;
    }
  }
  return parts;
}

export interface VerifyBatch {
  ids: string[];
  groupId: string | null;
}

const SEVERITY_RANK: Record<Finding["severity"], number> = { P1: 0, P2: 1, P3: 2, nit: 3 };

/**
 * Two findings share a root cause: the merge's own test, or, for findings whose
 * lines aren't comparable, such as from different rounds, one file with close
 * text. An external finding stays apart, because the loop must answer each one.
 */
function sameRootCause(a: Finding, b: Finding): boolean {
  if (a.origin === "pr_comment" || a.origin === "check_run") return false;
  if (b.origin === "pr_comment" || b.origin === "check_run") return false;
  if (sameIssue(a, b)) return true;
  if (a.file === null || a.file !== b.file) return false;
  return (
    titleSimilarity(a.title, b.title) >= ROOT_CAUSE_SIMILARITY ||
    textSimilarity(a.failureCase, b.failureCase) >= ROOT_CAUSE_SIMILARITY
  );
}

/**
 * Finds the findings a disprover needn't read, because another finding has the
 * same root cause. Returns each duplicate's id with the id of the finding it
 * follows: the most severe one, then the first one.
 */
export function rootCauseDuplicates(findings: readonly Finding[]): Map<string, string> {
  const ordered = [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id),
  );
  const kept: Finding[] = [];
  const duplicates = new Map<string, string>();
  for (const f of ordered) {
    const primary = kept.find((k) => sameRootCause(k, f));
    if (primary) duplicates.set(f.id, primary.id);
    else kept.push(f);
  }
  return duplicates;
}

/**
 * Splits findings into batches: one per group, apart by disprover vendor and by
 * reporter, so a fallback can't reach a batch member's reporter. A batch splits
 * further only for `tokenLimit`, never for how many findings it holds.
 */
export function planVerifyBatches(
  findings: readonly Finding[],
  options: {
    vendorFor: (f: Finding) => Vendor;
    reporterFor: (f: Finding) => Vendor | null;
    tokensFor: (f: Finding) => number;
    tokenLimit?: number;
  },
): VerifyBatch[] {
  const limit = options.tokenLimit ?? VERIFY_BATCH_TOKEN_LIMIT;
  const parts = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = [f.groupId ?? "", options.vendorFor(f), options.reporterFor(f) ?? ""].join("|");
    parts.set(key, [...(parts.get(key) ?? []), f]);
  }
  const batches: VerifyBatch[] = [];
  for (const key of [...parts.keys()].sort()) {
    let current: VerifyBatch | null = null;
    let size = 0;
    for (const f of parts.get(key) ?? []) {
      const tokens = options.tokensFor(f) + VERDICT_TOKEN_RESERVE;
      if (!current || size + tokens > limit) {
        current = { ids: [], groupId: f.groupId };
        batches.push(current);
        size = 0;
      }
      current.ids.push(f.id);
      size += tokens;
    }
  }
  return batches;
}
