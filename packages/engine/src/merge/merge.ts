// Merge stage (design.md, pre-push step 4): dedupe before any verify call.
import {
  FindingSchema,
  fromVendorFinding,
  type Finding,
  type FindingOrigin,
  type Severity,
  type Vendor,
  type VendorFinding,
} from "@aio/contracts";
import { textSimilarity, titleSimilarity } from "./fingerprint.js";

/** A raw finding from one agent, before the merge gives it an id. */
export interface Candidate {
  raw: VendorFinding;
  /** Reviewer label, such as `codex-gpt-5`. */
  reportedBy: string;
  vendor: Vendor;
  groupId: string | null;
  hunkIds: string[];
  origin: FindingOrigin;
  fingerprint: string;
  symbol: string;
}

export interface MergeContext {
  runId: string;
  round: number;
  /** Mints the next `F-0001` id. */
  nextId: () => string;
  /** Fixed findings whose return a person already accepted. */
  acceptedOscillations?: readonly string[];
  now: () => string;
  /**
   * The code version the candidates' lines count in, stored on each new
   * finding as `linesAt`. Absent means unknown, and then lines are never
   * compared, only fingerprints.
   */
  linesAt?: string;
  /** The run has no base, such as a whole-project run, so `introduced` is unknown. */
  noBase?: boolean;
}

export interface Oscillation {
  /** The finding a fix closed. */
  fixedId: string;
  /** The finding that came back. */
  returnedId: string;
}

export interface MergeResult {
  /** Every finding after the merge: the existing ones, updated, plus the new ones. */
  findings: Finding[];
  /** Ids of findings this merge created. */
  created: string[];
  /** Candidates folded into a finding, with the finding's id. */
  duplicates: Array<{ reportedBy: string; title: string; into: string }>;
  /** Candidates matching a disproved or waived finding, which are not raised again. */
  known: Array<{ reportedBy: string; title: string; matches: string }>;
  oscillations: Oscillation[];
  /** Share of created findings that more than one reviewer raised. */
  overlapRate: number;
}

const SEVERITY_RANK: Record<Severity, number> = { P1: 0, P2: 1, P3: 2, nit: 3 };

export function moreSevere(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

/**
 * How many lines apart two findings' ranges can be and still count as one
 * location: a bug and its neighbor report often point a line or two apart.
 */
export const NEAR_LINE_GAP = 3;

/** True when two line ranges overlap or sit within `gap` lines of each other. */
export function linesNear(
  a: readonly [number, number] | null,
  b: readonly [number, number] | null,
  gap = NEAR_LINE_GAP,
): boolean {
  if (!a || !b) return false;
  return a[0] <= b[1] + gap && b[0] <= a[1] + gap;
}

export function linesOverlap(
  a: readonly [number, number] | null,
  b: readonly [number, number] | null,
): boolean {
  if (!a || !b) return false;
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Two findings with overlapping lines are one issue when their titles or
 * their failure cases are at least this similar (`titleSimilarity`).
 */
export const SAME_ISSUE_SIMILARITY = 0.5;

interface Comparable {
  fingerprint: string;
  file: string | null;
  lines: readonly [number, number] | null;
  /** The code version `lines` count in; lines in different versions aren't compared. */
  linesAt?: string | undefined;
  title: string;
  failureCase: string;
}

/**
 * Two findings describe the same issue: they have the same fingerprint, or
 * their lines overlap or sit within `NEAR_LINE_GAP` lines in the same code
 * version and their titles or failure cases are similar. The category plays no part, since unrelated bugs often
 * share one.
 */
export function sameIssue(a: Comparable, b: Comparable): boolean {
  if (a.fingerprint === b.fingerprint) return true;
  if (a.file === null || a.file !== b.file) return false;
  if (a.linesAt === undefined || a.linesAt !== b.linesAt) return false;
  if (!linesNear(a.lines, b.lines)) return false;
  return (
    titleSimilarity(a.title, b.title) >= SAME_ISSUE_SIMILARITY ||
    textSimilarity(a.failureCase, b.failureCase) >= SAME_ISSUE_SIMILARITY
  );
}

/**
 * A finding that comes back after its fix. Lines move after a fix, so this
 * matches on the fingerprint, or on the same file and symbol with a close
 * title.
 */
export function returnsAfterFix(
  candidate: Candidate,
  fixed: Finding,
  fixedSymbol: string,
): boolean {
  if (candidate.fingerprint === fixed.fingerprint) return true;
  return (
    candidate.raw.file === fixed.file &&
    candidate.symbol !== "" &&
    candidate.symbol === fixedSymbol &&
    titleSimilarity(candidate.raw.title, fixed.title) >= 0.5
  );
}

function toComparable(c: Candidate, linesAt: string | undefined): Comparable {
  return {
    fingerprint: c.fingerprint,
    file: c.raw.file,
    lines: c.raw.lines,
    linesAt,
    title: c.raw.title,
    failureCase: c.raw.failure_case,
  };
}

/**
 * Merges candidates into the run's findings: dedupes by fingerprint and by
 * overlapping lines, drops candidates that match a closed verdict, flags a
 * fixed finding that returns, and computes the overlap rate.
 *
 * `symbols` gives each existing finding's enclosing symbol, keyed by id.
 */
export function mergeCandidates(
  existing: readonly Finding[],
  candidates: readonly Candidate[],
  ctx: MergeContext,
  symbols: ReadonlyMap<string, string> = new Map(),
): MergeResult {
  const findings = existing.map((f) => ({ ...f, alsoReportedBy: [...f.alsoReportedBy] }));
  const created: string[] = [];
  const duplicates: MergeResult["duplicates"] = [];
  const known: MergeResult["known"] = [];
  const oscillations: Oscillation[] = [];
  const accepted = new Set(ctx.acceptedOscillations ?? []);

  for (const candidate of candidates) {
    const cmp = toComparable(candidate, ctx.linesAt);
    const open = findings.find(
      (f) => (f.verdict === "pending" || f.verdict === "confirmed") && sameIssue(f, cmp),
    );
    if (open) {
      if (
        open.reportedBy !== candidate.reportedBy &&
        !open.alsoReportedBy.includes(candidate.reportedBy)
      ) {
        open.alsoReportedBy.push(candidate.reportedBy);
      }
      open.severity = moreSevere(open.severity, candidate.raw.severity);
      for (const h of candidate.hunkIds) if (!open.hunkIds.includes(h)) open.hunkIds.push(h);
      duplicates.push({
        reportedBy: candidate.reportedBy,
        title: candidate.raw.title,
        into: open.id,
      });
      continue;
    }
    const closed = findings.find(
      (f) => (f.verdict === "disproved" || f.verdict === "waived") && sameIssue(f, cmp),
    );
    if (closed) {
      known.push({
        reportedBy: candidate.reportedBy,
        title: candidate.raw.title,
        matches: closed.id,
      });
      continue;
    }
    const fixed = findings.find(
      (f) => f.verdict === "fixed" && returnsAfterFix(candidate, f, symbols.get(f.id) ?? ""),
    );
    // A returning finding is still created, so the decision can show both versions.
    const id = ctx.nextId();
    const finding = fromVendorFinding(
      { ...candidate.raw, verdict: "pending", verification: undefined, evidence: undefined },
      {
        id,
        fingerprint: candidate.fingerprint,
        reportedBy: candidate.reportedBy,
        runId: ctx.runId,
        round: ctx.round,
        groupId: candidate.groupId,
        hunkIds: candidate.hunkIds,
        origin: candidate.origin,
        ...(ctx.linesAt === undefined ? {} : { linesAt: ctx.linesAt }),
      },
    );
    if (ctx.noBase) finding.introduced = null;
    finding.history.push({
      time: ctx.now(),
      verdict: "pending",
      actor: { kind: "engine", role: "merge" },
      round: ctx.round,
    });
    findings.push(FindingSchema.parse(finding));
    created.push(id);
    if (fixed && !accepted.has(fixed.id)) oscillations.push({ fixedId: fixed.id, returnedId: id });
  }

  const createdSet = new Set(created);
  const multi = findings.filter((f) => createdSet.has(f.id) && f.alsoReportedBy.length > 0).length;
  const overlapRate = created.length === 0 ? 0 : multi / created.length;
  return { findings, created, duplicates, known, oscillations, overlapRate };
}

export interface FindingsLogEntry {
  id: string;
  verdict: "fixed" | "disproved" | "waived";
  severity: Severity;
  title: string;
  file: string | null;
  lines: [number, number] | null;
  reason: string;
}

/** The findings log every reviewer gets: closed findings with their reasons. */
export function findingsLog(findings: readonly Finding[]): FindingsLogEntry[] {
  const out: FindingsLogEntry[] = [];
  for (const f of findings) {
    if (f.verdict !== "fixed" && f.verdict !== "disproved" && f.verdict !== "waived") {
      continue;
    }
    const last = [...f.history].reverse().find((h) => h.verdict === f.verdict);
    const reason = (last?.evidence ?? f.evidence ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    out.push({
      id: f.id,
      verdict: f.verdict,
      severity: f.severity,
      title: f.title,
      file: f.file,
      lines: f.lines,
      reason,
    });
  }
  return out;
}
