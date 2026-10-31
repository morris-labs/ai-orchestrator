// The coverage ledger (design.md, "Reviewer depth"): every hunk a reviewer
// gets must come back with a verdict, either findings or "examined, sound".
import type { Hunk, VendorFinding } from "@agentbox/contracts";
import type { HunkVerdict } from "../core.js";

export type LedgerVerdict = "findings" | "sound" | "missing";

export interface LedgerEntry {
  hunkId: string;
  file: string;
  verdict: LedgerVerdict;
  reason: string;
  /** Reviewer labels that gave a verdict for the hunk. */
  reviewers: string[];
}

export interface GroupLedger {
  groupId: string | null;
  entries: LedgerEntry[];
}

/** True when a finding's lines touch the hunk. A deletion hunk covers the line before and after. */
export function findingTouchesHunk(
  finding: Pick<VendorFinding, "file" | "lines">,
  hunk: Hunk,
): boolean {
  if (finding.file !== hunk.file) return false;
  const [start, end] = finding.lines;
  const hStart = hunk.start === hunk.end ? Math.max(1, hunk.start) : hunk.start;
  const hEnd = hunk.start === hunk.end ? hunk.end + 1 : hunk.end;
  return start <= hEnd && end >= hStart;
}

/** The ids of the hunks a finding touches. */
export function hunksForFinding(
  finding: Pick<VendorFinding, "file" | "lines">,
  hunks: readonly Hunk[],
): string[] {
  return hunks.filter((h) => findingTouchesHunk(finding, h)).map((h) => h.id);
}

/** Starts an empty ledger for a set of hunks. */
export function newLedger(groupId: string | null, hunks: readonly Hunk[]): GroupLedger {
  return {
    groupId,
    entries: hunks.map((h) => ({
      hunkId: h.id,
      file: h.file,
      verdict: "missing",
      reason: "",
      reviewers: [],
    })),
  };
}

/**
 * Records a reviewer's answer in the ledger. A hunk gets `findings` when the
 * reviewer said so or a finding touches it, and `sound` when the reviewer
 * examined it and found nothing. Unknown hunk ids are ignored.
 */
export function recordVerdicts(
  ledger: GroupLedger,
  hunks: readonly Hunk[],
  reviewer: string,
  verdicts: readonly HunkVerdict[],
  findings: readonly Pick<VendorFinding, "file" | "lines" | "title">[],
): GroupLedger {
  const byId = new Map(verdicts.map((v) => [v.hunkId, v]));
  const entries = ledger.entries.map((entry) => {
    const hunk = hunks.find((h) => h.id === entry.hunkId);
    const touching = hunk ? findings.filter((f) => findingTouchesHunk(f, hunk)) : [];
    const stated = byId.get(entry.hunkId);
    let verdict: LedgerVerdict = entry.verdict;
    let reason = entry.reason;
    if (touching.length > 0 || stated?.verdict === "findings") {
      verdict = "findings";
      // A `sound` reason says nothing is wrong, so it never explains a hunk
      // that one of the reviewer's own findings touches.
      const statedReason = stated?.verdict === "findings" ? stated.reason : "";
      reason = statedReason || touching.map((f) => f.title).join("; ");
    } else if (stated?.verdict === "sound" && verdict !== "findings") {
      verdict = "sound";
      reason = stated.reason;
    }
    const reviewers =
      (stated || touching.length > 0) && !entry.reviewers.includes(reviewer)
        ? [...entry.reviewers, reviewer]
        : entry.reviewers;
    return { ...entry, verdict, reason, reviewers };
  });
  return { ...ledger, entries };
}

/** The hunks that still have no verdict. */
export function missingHunks(ledger: GroupLedger, hunks: readonly Hunk[]): Hunk[] {
  const missing = new Set(
    ledger.entries.filter((e) => e.verdict === "missing").map((e) => e.hunkId),
  );
  return hunks.filter((h) => missing.has(h.id));
}
