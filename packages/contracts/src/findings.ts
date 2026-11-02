// The finding schema from the review pipeline design
// (`~/Bin/Code Review Pipeline/docs/design.md`, "Finding schema"), extended
// with the run, round, file group, hunk ledger, and verdict history.
//
// Vendors return findings in the design's snake_case JSON
// (`VendorFindingSchema`). The engine converts each one with
// `fromVendorFinding()`, and everything after that point uses `Finding`.
import { z } from "zod";
import { CommitShaSchema, IsoDateTimeSchema, RunIdSchema, VendorSchema } from "./common.js";

export const SeveritySchema = z.enum(["P1", "P2", "P3", "nit"]);
export type Severity = z.infer<typeof SeveritySchema>;

/** Severities from the strongest down. `P1` is the strongest value the contracts define. */
const SEVERITY_ORDER: readonly Severity[] = ["P1", "P2", "P3", "nit"];

/**
 * True when a finding's severity is below the verification floor, so no
 * disprover checks it. An imported pull request comment or check failure is
 * never below the floor, because the post-push loop has to answer it.
 */
export function belowVerifyFloor(
  finding: { severity: Severity; origin?: string },
  floor: Severity | undefined,
): boolean {
  if (!floor) return false;
  if (finding.origin === "pr_comment" || finding.origin === "check_run") return false;
  return SEVERITY_ORDER.indexOf(finding.severity) > SEVERITY_ORDER.indexOf(floor);
}

/**
 * The design's four verdicts, plus `fixed` (a confirmed finding whose fix
 * passed the gate and the confirmer) and `waived` (a person chose to accept it).
 */
export const VerdictSchema = z.enum([
  "pending",
  "confirmed",
  "disproved",
  "pre-existing",
  "fixed",
  "waived",
]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const VerificationSchema = z.enum(["script", "code-reading"]);
export type Verification = z.infer<typeof VerificationSchema>;

/** Where a finding came from. Post-push imports use `pr_comment` and `check_run`. */
export const FindingOriginSchema = z.enum([
  "reviewer",
  "sweep",
  "confirmer",
  "pr_comment",
  "check_run",
]);
export type FindingOrigin = z.infer<typeof FindingOriginSchema>;

/** Who changed a finding's verdict. */
export const ActorSchema = z.object({
  kind: z.enum(["agent", "human", "engine"]),
  vendor: VendorSchema.optional(),
  model: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

/** One verdict change in a finding's trail. */
export const FindingHistoryEntrySchema = z.object({
  time: IsoDateTimeSchema,
  verdict: VerdictSchema,
  actor: ActorSchema,
  evidence: z.string().optional(),
  round: z.number().int().positive().optional(),
});
export type FindingHistoryEntry = z.infer<typeof FindingHistoryEntrySchema>;

/** A link to the pull request thread or check run a post-push finding came from. */
export const ExternalRefSchema = z.object({
  kind: z.enum(["pr_comment", "check_run"]),
  id: z.string().min(1),
  url: z.string().url().optional(),
});
export type ExternalRef = z.infer<typeof ExternalRefSchema>;

const LinesSchema = z
  .tuple([z.number().int().positive(), z.number().int().positive()])
  .refine(([start, end]) => end >= start, { message: "end line must not precede start line" });

/** Origins whose findings can lack a file and lines, such as a general PR comment. */
const UNLOCATED_ORIGINS: readonly FindingOrigin[] = ["pr_comment", "check_run"];

const findingFields = {
  /** `F-0001` and up, unique within a run. */
  id: z.string().regex(/^F-\d{4,}$/),
  /** SHA-1 of the file, the symbol, and the normalized title. */
  fingerprint: z.string().min(1),
  severity: SeveritySchema,
  title: z.string().min(1),
  /** `null` only for a `pr_comment` or `check_run` finding with no location. */
  file: z.string().min(1).nullable(),
  /** The function, class, or other symbol the finding is about, when the reviewer names one. */
  symbol: z.string().min(1).optional(),
  /** First and last line, inclusive, in the tip version of `file`; `null` with `file`. */
  lines: LinesSchema.nullable(),
  /**
   * The version of the code that `lines` count in: the tip commit when the
   * finding was raised, prefixed with `worktree:` when the round reviewed
   * uncommitted changes. The merge compares two findings' lines only when
   * this matches. Absent on imported findings and on findings stored before
   * the field existed.
   */
  linesAt: z.string().min(1).optional(),
  failureCase: z.string(),
  category: z.string().min(1),
  /** False when the flaw already exists at the pinned base. */
  introduced: z.boolean(),
  /**
   * Why a pending finding has no verdict. `below_verify_floor`: its severity
   * is below the run's verification floor, so no disprover checked it.
   * Absent otherwise and on findings stored before the field existed.
   */
  unverifiedReason: z.enum(["below_verify_floor"]).optional(),
  /** Reviewer label, such as `claude-opus` or `codex-gpt-5`. */
  reportedBy: z.string().min(1),
  /** Other reviewers whose findings merged into this one; drives the overlap rate. */
  alsoReportedBy: z.array(z.string().min(1)),
  verdict: VerdictSchema,
  /** How the verdict was reached. `null` while the verdict is `pending`. */
  verification: VerificationSchema.nullable(),
  evidence: z.string(),
  runId: RunIdSchema,
  round: z.number().int().positive(),
  /** `null` for findings that span groups, such as an imported PR comment. */
  groupId: z.string().min(1).nullable(),
  hunkIds: z.array(z.string().min(1)),
  origin: FindingOriginSchema,
  externalRef: ExternalRefSchema.optional(),
  /** The commit that fixed it, once the verdict is `fixed`. */
  fixCommit: CommitShaSchema.optional(),
  history: z.array(FindingHistoryEntrySchema),
};

function checkLocation(
  f: { origin: FindingOrigin; file: string | null; lines: unknown },
  ctx: z.RefinementCtx,
) {
  if ((f.file === null) !== (f.lines === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lines"],
      message: "file and lines must both be set or both be null",
    });
  }
  if (f.file === null && !UNLOCATED_ORIGINS.includes(f.origin)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["file"],
      message: `a ${f.origin} finding needs a file and lines`,
    });
  }
}

/** A finding as stored and returned: every field present. */
export const FindingSchema = z.object(findingFields).superRefine(checkLocation);
export type Finding = z.infer<typeof FindingSchema>;

/** A finding with defaults for the lists, `verification`, `evidence`, and `origin`. Outputs a `Finding`. */
export const FindingInputSchema = z
  .object({
    ...findingFields,
    alsoReportedBy: z.array(z.string().min(1)).default([]),
    verification: VerificationSchema.nullable().default(null),
    evidence: z.string().default(""),
    hunkIds: z.array(z.string().min(1)).default([]),
    origin: FindingOriginSchema.default("reviewer"),
    history: z.array(FindingHistoryEntrySchema).default([]),
  })
  .superRefine(checkLocation);

/** The JSON a reviewer returns, exactly as in design.md. */
export const VendorFindingSchema = z.object({
  id: z.string().optional(),
  fingerprint: z.string().optional(),
  severity: SeveritySchema,
  title: z.string().min(1),
  file: z.string().min(1),
  /** The enclosing symbol; part of the fingerprint when present. */
  symbol: z.string().min(1).optional(),
  lines: LinesSchema,
  failure_case: z.string(),
  category: z.string().min(1),
  introduced: z.boolean(),
  reported_by: z.string().min(1).optional(),
  verdict: VerdictSchema.default("pending"),
  verification: VerificationSchema.optional(),
  evidence: z.string().optional(),
});
export type VendorFinding = z.infer<typeof VendorFindingSchema>;

/** Fields the engine supplies when it accepts a vendor finding into a run. */
export interface FindingContext {
  id: string;
  fingerprint: string;
  reportedBy: string;
  runId: string;
  round: number;
  groupId: string | null;
  hunkIds?: string[];
  origin?: FindingOrigin;
  /** The code version the lines count in; see `Finding.linesAt`. */
  linesAt?: string;
}

/** Converts a vendor's snake_case finding into a `Finding`. */
export function fromVendorFinding(raw: VendorFinding, ctx: FindingContext): Finding {
  return FindingInputSchema.parse({
    id: ctx.id,
    fingerprint: ctx.fingerprint,
    severity: raw.severity,
    title: raw.title,
    file: raw.file,
    ...(raw.symbol === undefined ? {} : { symbol: raw.symbol }),
    lines: raw.lines,
    ...(ctx.linesAt === undefined ? {} : { linesAt: ctx.linesAt }),
    failureCase: raw.failure_case,
    category: raw.category,
    introduced: raw.introduced,
    reportedBy: ctx.reportedBy,
    verdict: raw.verdict,
    verification: raw.verification ?? null,
    evidence: raw.evidence ?? "",
    runId: ctx.runId,
    round: ctx.round,
    groupId: ctx.groupId,
    hunkIds: ctx.hunkIds ?? [],
    origin: ctx.origin ?? "reviewer",
  });
}
