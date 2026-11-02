// Review runs: what starts one, its live state, its file groups, and its
// per-round summaries. The engine writes these as JSON under
// `<project>/.aio/runs/<run id>/`, and the server mirrors them.
import { z } from "zod";
import {
  CommitShaSchema,
  CountSchema,
  FractionSchema,
  IsoDateTimeSchema,
  RunIdSchema,
  VendorSchema,
} from "./common.js";
import { ModelTierChoiceSchema, ModelTierSchema } from "./tiers.js";

export const PipelineSchema = z.enum(["pre-push", "post-push"]);
export type Pipeline = z.infer<typeof PipelineSchema>;

export const ProfileSchema = z.enum(["offload", "balanced", "fast"]);
export type Profile = z.infer<typeof ProfileSchema>;

/** A role a vendor can hold in a run. */
export const RoleSchema = z.enum(["reviewer", "disprover", "confirmer", "fixer"]);
export type Role = z.infer<typeof RoleSchema>;

/** The kind of agent call. `sweeper` is the pattern sweep's cheap agent. */
export const AgentRoleSchema = z.enum(["reviewer", "disprover", "confirmer", "fixer", "sweeper"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "paused",
  "waiting_decision",
  "finished",
  "failed",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const StageSchema = z.enum([
  "preflight",
  "group",
  "find",
  "merge",
  "verify",
  "fix",
  "gate",
  "confirm",
  "sweep",
  "push",
  "poll",
  "import",
  "done",
]);
export type Stage = z.infer<typeof StageSchema>;

/** The vendor for each role. Several reviewers can run in one round. */
export const RoleAssignmentSchema = z.object({
  reviewer: z.array(VendorSchema).min(1),
  disprover: VendorSchema,
  confirmer: VendorSchema,
  fixer: VendorSchema,
});
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

/**
 * Roles a run starts with in place of the profile's defaults. Each role it
 * names holds from round 1 until a profile switch, like a role a person
 * assigns with `runs.assign`; the roles it leaves out follow the profile.
 */
export const RoleOverridesSchema = RoleAssignmentSchema.partial();
export type RoleOverrides = z.infer<typeof RoleOverridesSchema>;

/** Rounds in which the `balanced` profile has Claude review. */
export const BALANCED_CLAUDE_ROUNDS = 2;

/**
 * The roles each vendor can take when the engine or the server chooses for it:
 * a fallback, a replacement, or a role with no available default. A person can
 * still name any vendor for a role. Copilot disproves because the `offload`
 * profile relies on it for Codex's findings.
 */
export const VENDOR_ROLES: Record<z.infer<typeof VendorSchema>, readonly AgentRole[]> = {
  claude: ["reviewer", "disprover", "fixer", "sweeper"],
  codex: ["reviewer", "disprover", "confirmer", "sweeper"],
  copilot: ["reviewer", "disprover", "sweeper"],
};

/** The roles a profile gives in a round, before availability and manual changes. */
export function profileRoles(profile: Profile, round: number): RoleAssignment {
  switch (profile) {
    case "offload":
      return {
        reviewer: ["codex", "copilot"],
        disprover: "codex",
        confirmer: "codex",
        fixer: "claude",
      };
    case "balanced":
      return round <= BALANCED_CLAUDE_ROUNDS
        ? {
            reviewer: ["claude", "codex", "copilot"],
            disprover: "codex",
            confirmer: "codex",
            fixer: "claude",
          }
        : {
            reviewer: ["codex", "copilot"],
            disprover: "codex",
            confirmer: "codex",
            fixer: "claude",
          };
    case "fast":
      return {
        reviewer: ["claude", "codex"],
        disprover: "claude",
        confirmer: "codex",
        fixer: "claude",
      };
  }
}

/** A run request with every default resolved, as `RunState.request` stores it. */
export const ResolvedRunRequestSchema = z.object({
  projectId: z.string().min(1),
  boxId: z.string().min(1).optional(),
  /** Repository path as the container sees it. */
  repoPath: z.string().min(1),
  /** A branch, tag, or commit, or `pr` for the open pull request's base. */
  base: z.string().min(1),
  /** The branch to review and fix, or a commit with `readOnly`. Absent means the checked-out branch. */
  tip: z.string().min(1).optional(),
  /** Diff from the merge base of base and tip (`git diff BASE...TIP`). */
  mergeBase: z.boolean(),
  /** The CLI's `--exact-base`. True forces `mergeBase` to false. */
  exactBase: z.boolean(),
  pipeline: PipelineSchema,
  prNumber: z.number().int().positive().optional(),
  profile: ProfileSchema,
  /** Review without fixing. */
  readOnly: z.boolean(),
  /** Review uncommitted changes instead of refusing a dirty tree. */
  includeWorktree: z.boolean(),
  /**
   * Disprover and confirmer come from a vendor other than the one that did
   * the work. False uses a fresh agent on the same vendor.
   */
  crossVendor: z.boolean(),
  roundCap: z.number().int().positive(),
  overlapThreshold: FractionSchema,
  continuationCap: z.number().int().nonnegative(),
  /**
   * Roles that replace the profile's defaults from round 1. Absent in
   * requests from clients and runs that predate it.
   */
  roles: RoleOverridesSchema.optional(),
  /**
   * `auto`, or a tier for the run. A fixed `small` tier still gives code,
   * disprovers, confirmers, and fixers the medium tier. The engine stores
   * `auto` for a new request without it. A stored run without it uses each
   * vendor's configured model; where a CLI default could be a blocked model,
   * it uses the safe fallback model instead.
   */
  modelTier: ModelTierChoiceSchema.optional(),
});
export type ResolvedRunRequest = z.infer<typeof ResolvedRunRequestSchema>;

/** The fields of a run request with the design.md defaults, before `exactBase` is folded in. */
export const RunRequestFieldsSchema = ResolvedRunRequestSchema.extend({
  base: z.string().min(1).default("origin/main"),
  mergeBase: z.boolean().default(true),
  exactBase: z.boolean().default(false),
  pipeline: PipelineSchema.default("pre-push"),
  profile: ProfileSchema.default("offload"),
  readOnly: z.boolean().default(false),
  includeWorktree: z.boolean().default(false),
  crossVendor: z.boolean().default(true),
  roundCap: z.number().int().positive().default(25),
  overlapThreshold: FractionSchema.default(0.5),
  continuationCap: z.number().int().nonnegative().default(3),
});

const foldExactBase = <T extends { exactBase: boolean; mergeBase: boolean }>(r: T): T =>
  r.exactBase ? { ...r, mergeBase: false } : r;

/** The reason every layer gives when it refuses a read-only post-push request. */
export const READ_ONLY_POST_PUSH_MESSAGE =
  "A read-only run can't use the post-push pipeline, which pushes, opens a pull request, and commits fixes.";

/** True when a request asks for a read-only run of the post-push pipeline. */
export function isReadOnlyPostPush(r: { readOnly: boolean; pipeline: Pipeline }): boolean {
  return r.readOnly && r.pipeline === "post-push";
}

function refuseReadOnlyPostPush(
  r: { readOnly: boolean; pipeline: Pipeline },
  ctx: z.RefinementCtx,
): void {
  if (isReadOnlyPostPush(r)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["readOnly"],
      message: READ_ONLY_POST_PUSH_MESSAGE,
    });
  }
}

/**
 * What starts a run: the body of the server's `runs.create`. Defaults follow
 * design.md. A read-only request can't use the post-push pipeline.
 */
export const RunRequestSchema =
  RunRequestFieldsSchema.superRefine(refuseReadOnlyPostPush).transform(foldExactBase);
export type RunRequest = z.infer<typeof RunRequestSchema>;
export type RunRequestInput = z.input<typeof RunRequestSchema>;

/**
 * The body of the engine's `engine.runs.create`: the request plus the run id
 * the server minted. The engine stores the run under that id.
 */
export const EngineRunCreateSchema = RunRequestFieldsSchema.extend({
  runId: RunIdSchema,
})
  .superRefine(refuseReadOnlyPostPush)
  .transform(foldExactBase);
export type EngineRunCreate = z.infer<typeof EngineRunCreateSchema>;

export const StopReasonSchema = z.enum([
  "clean",
  "round_cap",
  "oscillation",
  "ceiling",
  "gate_failed",
  "push_blocked",
  "pr_clean",
  "non_code_failures",
  "cancelled",
  "error",
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

export const DecisionOptionSchema = z.enum(["resume", "resume_waive", "cancel"]);
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

/** Why a run waits for a person, and what the person can choose. */
export const DecisionSchema = z.object({
  kind: z.enum(["oscillation", "round_cap", "ceiling", "gate_failed", "push_blocked"]),
  findingIds: z.array(z.string().min(1)),
  options: z.array(DecisionOptionSchema).min(1),
  message: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

/** A person's answer to a `Decision`. */
export const DecisionAnswerSchema = z.object({
  option: DecisionOptionSchema,
  /** With `resume_waive`: the findings to waive. */
  waiveFindingIds: z.array(z.string().min(1)).default([]),
  reason: z.string().optional(),
});
export type DecisionAnswer = z.infer<typeof DecisionAnswerSchema>;

export const RunStateSchema = z.object({
  /**
   * A ULID the server mints and passes to the engine in `engine.runs.create`.
   * Unique across every engine; also the run directory's name.
   */
  id: RunIdSchema,
  projectId: z.string().min(1),
  boxId: z.string().min(1).optional(),
  container: z.string().min(1),
  request: ResolvedRunRequestSchema,
  status: RunStatusSchema,
  stage: StageSchema,
  /** 0 until the first find stage starts. */
  round: CountSchema,
  /** The base, pinned when the run starts. */
  baseSha: CommitShaSchema.optional(),
  /** The tip as of the current round. */
  tipSha: CommitShaSchema.optional(),
  profile: ProfileSchema,
  roles: RoleAssignmentSchema,
  stopReason: StopReasonSchema.nullable(),
  decision: DecisionSchema.nullable(),
  /** When a ceiling paused the run: when it resumes. */
  pausedUntil: IsoDateTimeSchema.optional(),
  prNumber: z.number().int().positive().optional(),
  prUrl: z.string().url().optional(),
  error: z.string().optional(),
  /**
   * Problems the run reports without stopping for them, such as a Copilot
   * review request that GitHub dropped. Oldest first.
   */
  notices: z.array(z.string()).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.optional(),
});
export type RunState = z.infer<typeof RunStateSchema>;

/** One diff hunk in the coverage ledger. Lines are in the tip version. */
export const HunkSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type Hunk = z.infer<typeof HunkSchema>;

export const FileGroupSchema = z.object({
  id: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
  kind: z.enum(["major", "minor"]),
  changedLines: CountSchema,
  /** True when any file matches a policy risk path; such a group is always major. */
  riskPath: z.boolean(),
  hunks: z.array(HunkSchema),
  /** The group's model tier. Absent in runs that predate tiers. */
  tier: ModelTierSchema.optional(),
  /** Why the group has its tier. */
  tierReason: z.string().optional(),
});
export type FileGroup = z.infer<typeof FileGroupSchema>;

export const VendorRoundStatsSchema = z.object({
  raised: CountSchema,
  confirmed: CountSchema,
  disproved: CountSchema,
  tokensIn: CountSchema,
  tokensOut: CountSchema,
  /** Copilot premium requests; 0 for other vendors. */
  premiumRequests: z.number().nonnegative(),
  /** Copilot AI credits, when the CLI reports them; absent otherwise. */
  aiCredits: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative(),
});
export type VendorRoundStats = z.infer<typeof VendorRoundStatsSchema>;

export const RoundSummarySchema = z.object({
  runId: RunIdSchema,
  round: z.number().int().positive(),
  perVendor: z.record(VendorSchema, VendorRoundStatsSchema),
  fixed: CountSchema,
  /** Share of merged findings that more than one reviewer raised. */
  overlapRate: FractionSchema,
  /** Estimated total cost of the round, in US dollars. */
  costUsd: z.number().nonnegative(),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema,
});
export type RoundSummary = z.infer<typeof RoundSummarySchema>;
