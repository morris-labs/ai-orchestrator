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
import { SeveritySchema, type Severity } from "./findings.js";
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

/**
 * How much a run spends looking for problems. `standard` asks for P1 and P2
 * findings with coarser groups, one reviewer pass per group, batched
 * verification, and at most two rounds. `thorough` is the full pipeline.
 */
export const RunDepthSchema = z.enum(["standard", "thorough"]);
export type RunDepth = z.infer<typeof RunDepthSchema>;

/**
 * What a run reviews. Absent means the change from a base to the tip. `whole`
 * reviews the project at the tip, from Git's empty tree, and ignores `base`.
 */
export const RunScopeSchema = z.enum(["whole"]);
export type RunScope = z.infer<typeof RunScopeSchema>;

/**
 * Paths that a `whole` run leaves out by default: lockfiles, and minified,
 * vendored, and generated files. The preview lists what they match.
 */
export const WHOLE_PROJECT_EXCLUDES: readonly string[] = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "Pipfile.lock",
  "poetry.lock",
  "uv.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.pb.go",
  "*_pb2.py",
  "*.generated.*",
  "**/.aio/**",
  "**/dist/**",
  "**/vendor/**",
  "**/node_modules/**",
  "**/third_party/**",
  "**/__generated__/**",
];

/** What each depth gives a request that leaves a setting out. */
export const DEPTH_DEFAULTS: Record<
  RunDepth,
  { roundCap: number; continuationCap: number; verifyFloor?: Severity }
> = {
  standard: { roundCap: 2, continuationCap: 0, verifyFloor: "P2" },
  thorough: { roundCap: 25, continuationCap: 3 },
};

/** The round cap of a post-push request, whose rounds answer pull request comments. */
export const POST_PUSH_ROUND_CAP = 25;

/**
 * The round cap of a run's post-push loop. A post-push request's own cap applies.
 * A pre-push run that continues after a push doesn't inherit its pre-push cap.
 */
export function postPushRoundCap(request: { pipeline: Pipeline; roundCap: number }): number {
  return request.pipeline === "post-push" ? request.roundCap : POST_PUSH_ROUND_CAP;
}

/** A run's depth. A stored run without the field predates depths and stays `thorough`. */
export function runDepth(request: { depth?: RunDepth | undefined }): RunDepth {
  return request.depth ?? "thorough";
}

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
  /**
   * The lowest severity that a disprover checks. Findings below it stay
   * `pending`, never count as confirmed, and never reach the fixer. Absent
   * means every severity.
   */
  verifyFloor: SeveritySchema.optional(),
  /** Absent in runs that predate depths, which stay `thorough`. See `runDepth`. */
  depth: RunDepthSchema.optional(),
  /** What the run reviews. Absent in runs that review a range, and in older runs. */
  scope: RunScopeSchema.optional(),
  /** Globs of files this run never groups or reviews, added to the policy's `excludePaths`. */
  excludePaths: z.array(z.string().min(1)).optional(),
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
  roundCap: z.number().int().positive().optional(),
  overlapThreshold: FractionSchema.default(0.5),
  continuationCap: z.number().int().nonnegative().optional(),
  depth: RunDepthSchema.default("standard"),
});

/**
 * Fills what the depth decides and folds `exactBase` in. Settings a request
 * names win. Parsing a request again changes nothing, because the server and
 * the engine both parse it. To check every severity at `standard`, name the
 * `nit` floor: no severity ranks below it.
 */
function resolveRequest<
  T extends {
    exactBase: boolean;
    mergeBase: boolean;
    depth: RunDepth;
    pipeline: Pipeline;
    roundCap?: number | undefined;
    continuationCap?: number | undefined;
    verifyFloor?: Severity | undefined;
    scope?: RunScope | undefined;
  },
>(r: T): T & { roundCap: number; continuationCap: number } {
  const defaults = DEPTH_DEFAULTS[r.depth];
  const postPush = r.pipeline === "post-push";
  const verifyFloor = r.verifyFloor ?? defaults.verifyFloor;
  return {
    ...r,
    ...(r.exactBase || r.scope === "whole" ? { mergeBase: false } : {}),
    roundCap: r.roundCap ?? (postPush ? POST_PUSH_ROUND_CAP : defaults.roundCap),
    continuationCap: r.continuationCap ?? defaults.continuationCap,
    ...(verifyFloor ? { verifyFloor } : {}),
  };
}

/** The reason every layer gives when it refuses a read-only post-push request. */
export const READ_ONLY_POST_PUSH_MESSAGE =
  "A read-only run can't use the post-push pipeline, which pushes, opens a pull request, and commits fixes.";

/** True when a request asks for a read-only run of the post-push pipeline. */
export function isReadOnlyPostPush(r: { readOnly: boolean; pipeline: Pipeline }): boolean {
  return r.readOnly && r.pipeline === "post-push";
}

/** The reason every layer gives when it refuses a whole-project post-push request. */
export const WHOLE_POST_PUSH_MESSAGE =
  "A whole-project run can't use the post-push pipeline, which answers a pull request's diff.";

/** True when a request asks for a whole-project run of the post-push pipeline. */
export function isWholePostPush(r: { scope?: RunScope | undefined; pipeline: Pipeline }): boolean {
  return r.scope === "whole" && r.pipeline === "post-push";
}

function refuseReadOnlyPostPush(
  r: { readOnly: boolean; pipeline: Pipeline; scope?: RunScope | undefined },
  ctx: z.RefinementCtx,
): void {
  if (isWholePostPush(r)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scope"],
      message: WHOLE_POST_PUSH_MESSAGE,
    });
  }
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
  RunRequestFieldsSchema.superRefine(refuseReadOnlyPostPush).transform(resolveRequest);
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
  .transform(resolveRequest);
export type EngineRunCreate = z.infer<typeof EngineRunCreateSchema>;

export const StopReasonSchema = z.enum([
  "clean",
  /** Clean at and above the verification floor, with findings below it left unchecked. */
  "clean_above_floor",
  /** Clean except for findings that no vendor would check; they wait for a person. */
  "clean_with_followups",
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

/**
 * The body of `runs.retry`. Roles replace the run's roles for calls that
 * haven't started. A verification floor replaces the run's floor; `all`
 * removes it, and absent keeps it. `finishWithClaude` gives every role that
 * Claude can take to Claude and turns off the cross-vendor rule for the rest of
 * the run, so Claude checks its own work.
 */
export const RunRetrySchema = z.object({
  roles: RoleOverridesSchema.optional(),
  verifyFloor: z.union([SeveritySchema, z.literal("all")]).optional(),
  finishWithClaude: z.boolean().optional(),
});
export type RunRetry = z.infer<typeof RunRetrySchema>;

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

/** The default group size limit at `standard`, unless the policy file sets one. */
export const STANDARD_GROUP_SIZE_LIMIT = 1500;

/**
 * Per-group and per-line token figures behind `estimateRunTokens`. They start
 * from one real `thorough` run of 140 million tokens over 107 groups, about
 * 1.3 million per group. The `standard` figures are planning guesses, because
 * no `standard` run has been measured. Change them from logged data.
 */
export const TOKEN_ESTIMATE = {
  thorough: { perGroup: 1_200_000, perLine: 100 },
  standard: { perGroup: 500_000, perLine: 75 },
} as const;

export interface RunTokenEstimate {
  /** The estimated tokens of the whole run, to two significant figures. */
  tokens: number;
  /** What the number comes from, for a person to read. */
  basis: string;
}

/**
 * A rough token estimate for a run, from its changed lines and group count.
 * Plain arithmetic: it calls no model, and it can't know how many findings a
 * run gets, which moves the real number the most.
 */
export function estimateRunTokens(input: {
  depth: RunDepth;
  groups: number;
  changedLines: number;
}): RunTokenEstimate {
  const { perGroup, perLine } = TOKEN_ESTIMATE[input.depth];
  const raw = input.groups * perGroup + input.changedLines * perLine;
  return {
    tokens: Number(raw.toPrecision(2)),
    basis: `${input.groups} groups at ${perGroup.toLocaleString("en-US")} tokens each, plus ${input.changedLines} changed lines at ${perLine} tokens each, for the ${input.depth} depth. Real runs can differ a lot, mostly with the number of findings.`,
  };
}
