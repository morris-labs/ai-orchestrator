// Review runs: what starts one, its live state, its file groups, and its
// per-round summaries. The engine writes these as JSON under
// `<project>/.aio/runs/<run id>/`, and the server mirrors them.
import { z } from "zod";
import {
  CommitShaSchema,
  CountSchema,
  EffortSchema,
  FractionSchema,
  IsoDateTimeSchema,
  RunIdSchema,
  VendorSchema,
  type Vendor,
} from "./common.js";
import { RootCauseSummarySchema, SeveritySchema, type Severity } from "./findings.js";
import { ModelTierChoiceSchema, ModelTierSchema, type ModelTier } from "./tiers.js";

export const PipelineSchema = z.enum(["pre-push", "post-push"]);
export type Pipeline = z.infer<typeof PipelineSchema>;

export const ProfileSchema = z.enum(["offload", "balanced", "fast"]);
export type Profile = z.infer<typeof ProfileSchema>;

/** A role a vendor can hold in a run. */
export const RoleSchema = z.enum(["reviewer", "disprover", "confirmer", "fixer"]);
export type Role = z.infer<typeof RoleSchema>;

/** The kind of agent call. `sweeper` is the pattern sweep's cheap agent. */
/** The most calls a run can make at once in one stage. */
export const MAX_CONCURRENCY = 20;
/**
 * The link capability of a server that honours a run request's
 * `concurrency`. An older server drops the field and runs at its defaults,
 * so a client sends the field only to a server that lists this.
 */
export const RUN_CONCURRENCY_CAPABILITY = "runs.concurrency.v1";

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
  /**
   * The reasoning effort for reviewer calls on vendors that take one. Absent
   * means each vendor's own default.
   */
  reviewerEffort: EffortSchema.optional(),
  /**
   * How many review calls run at once on each vendor, and how many
   * verification calls run at once, counting the single-finding calls of a
   * batch that falls back to one call per finding. Absent means 6 review
   * calls per vendor and 4 verification calls.
   */
  concurrency: z.number().int().min(1).max(MAX_CONCURRENCY).optional(),
  /** What the run reviews. Absent in runs that review a range, and in older runs. */
  scope: RunScopeSchema.optional(),
  /** Globs of files this run never groups or reviews, added to the policy's `excludePaths`. */
  excludePaths: z.array(z.string().min(1)).optional(),
  /**
   * Ends the run with one cheap call that clusters confirmed findings by
   * root cause (`RunState.rootCauses`). Absent or false skips it.
   */
  rootCauses: z.boolean().optional(),
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

/** Where a task in a run's task list stands. */
export const RunTaskStateSchema = z.enum(["queued", "running", "done", "failed", "skipped"]);
export type RunTaskState = z.infer<typeof RunTaskStateSchema>;

/**
 * One agent call in a run's task list. The engine adds a task when it plans
 * the call, or when the call starts if nothing planned it, and keeps the
 * list in pipeline order.
 */
export const RunTaskSchema = z.object({
  /** The call's cache key, unique in the round. */
  key: z.string().min(1),
  round: CountSchema,
  stage: StageSchema,
  role: AgentRoleSchema,
  groupId: z.string().min(1).nullable(),
  /** A short description for a person to read. */
  label: z.string().min(1),
  /** The vendor that takes or took the call. Absent until it's assigned. */
  vendor: VendorSchema.optional(),
  /** The reasoning effort the call asks for. Absent means the vendor's own default. */
  effort: z.string().min(1).optional(),
  state: RunTaskStateSchema,
  /** When the call last started. */
  startedAt: IsoDateTimeSchema.optional(),
  /** When the call ended. */
  finishedAt: IsoDateTimeSchema.optional(),
  /** The order the engine added it in, which breaks ties within a stage. */
  seq: CountSchema,
});
export type RunTask = z.infer<typeof RunTaskSchema>;

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
  /** Every planned and started agent call, in pipeline order. Absent on runs from before task lists. */
  tasks: z.array(RunTaskSchema).optional(),
  /** Confirmed findings by root cause, when the request asked for `rootCauses`. */
  rootCauses: RootCauseSummarySchema.optional(),
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
 * The fallback figures for a vendor or setup with no measurement. They start
 * from one real `thorough` run of 140 million tokens over 107 groups, and they
 * cover the whole run, verification and fixing included.
 */
export const TOKEN_ESTIMATE = {
  thorough: { perGroup: 1_200_000, perLine: 100 },
  standard: { perGroup: 500_000, perLine: 75 },
} as const;

/**
 * Measured reviewer tokens per group for Claude at the `standard` depth, used
 * until a project has its own runs. A whole-project run depends on the tier and
 * effort. `high` holds for `xhigh` and `max`, which have no measurement.
 */
export const STARTING_REVIEW_RATES = {
  whole: {
    small: { base: 70_000, high: 130_000 },
    medium: { base: 70_000, high: 130_000 },
    large: { base: 290_000, high: 580_000 },
  },
  /** One measured run, with no difference by tier. */
  range: { perGroup: 600_000 },
} as const;

/** Measured tokens per group at the `standard` depth, used until a project has its own runs. */
export const STARTING_STAGE_RATES = { verification: 40_000, fixing: 95_000 } as const;

/** How far a line built on one measurement can move, as multiples of its figure. */
const REVIEW_SPREAD = { low: 0.6, high: 1.6 };
/** Findings drive these lines, and an estimate can't see findings. */
const FINDINGS_SPREAD = { low: 0.3, high: 3 };
/** The margins around the lowest and highest of several measured runs. */
const SAMPLE_MARGIN = { low: 0.8, high: 1.25 };
/** The newest runs of each origin, this project or the others, that a rate comes from. */
const SAMPLE_LIMIT = 12;
/** Each run counts this share of the next newer run of its origin. */
const RECENCY_DECAY = 0.8;
/** How much a run in another project counts next to a run in this project. */
const HOST_WEIGHT = 0.5;
/** With fewer matching runs in this project, runs in other projects join them. */
const ENOUGH_RUNS = 2;
/**
 * Reviewer tokens per changed line on top of a base per group, for samples
 * whose group sizes are too alike to fit a rate of their own. Measured over
 * 236 groups of one whole-project run.
 */
const PRIOR_PER_LINE = 30;
/** The most per-group points that one sample keeps. */
export const TOKEN_SAMPLE_POINT_LIMIT = 500;
/** The most samples from other projects that a preview takes. */
export const HOST_TOKEN_SAMPLE_LIMIT = 200;
/** The file in a finished run folder that holds the run's `RunTokenSample`. */
export const TOKEN_SAMPLE_FILE = "token-sample.json";

/** The usage windows a vendor reports, as in `UsageWindowSchema` in `events.ts`. */
const SampleWindowSchema = z.enum(["5h", "7d", "month"]);
type SampleWindow = z.infer<typeof SampleWindowSchema>;

/**
 * Starting weights for each token kind, relative to one fresh input token,
 * in how much it counts toward a subscription's usage window. They are the
 * vendors' API price ratios: Anthropic charges 1.25 times the input price for
 * a 5-minute cache write, 0.1 times for a cache read, and 5 times for output;
 * OpenAI charges 0.1 times the input price for cached input and 8 times for
 * output. The vendors don't publish how plans count tokens, so a run's
 * measured rate per weighted token absorbs the rest.
 */
export const USAGE_WEIGHTS = {
  claude: { fresh: 1, cacheWrite: 1.25, cacheRead: 0.1, out: 5 },
  codex: { fresh: 1, cacheWrite: 1, cacheRead: 0.1, out: 8 },
  copilot: { fresh: 1, cacheWrite: 1.25, cacheRead: 0.1, out: 5 },
} as const satisfies Record<
  Vendor,
  { fresh: number; cacheWrite: number; cacheRead: number; out: number }
>;

/** Tokens by kind. */
export interface TokenKinds {
  fresh: number;
  cacheWrite: number;
  cacheRead: number;
  out: number;
}

/** Tokens by kind, weighted by `USAGE_WEIGHTS` into fresh-input equivalents. */
export function weightedTokens(vendor: Vendor, kinds: TokenKinds): number {
  const w = USAGE_WEIGHTS[vendor];
  return (
    kinds.fresh * w.fresh +
    kinds.cacheWrite * w.cacheWrite +
    kinds.cacheRead * w.cacheRead +
    kinds.out * w.out
  );
}

/**
 * How one run moved one usage window: the share of the window it used, and
 * the weighted tokens of the calls over the same stretch. `rate` is `used`
 * divided by `weighted`.
 */
export const WindowRateSchema = z.object({
  window: SampleWindowSchema,
  /** Share of the window used over the measured stretch: 1 means the whole window. */
  used: z.number().nonnegative(),
  /** Weighted tokens of the calls in the measured stretch. */
  weighted: z.number().nonnegative(),
  /** `used` per weighted token. */
  rate: z.number().nonnegative(),
  /** The length of the measured stretch, in milliseconds. */
  durationMs: CountSchema,
  /** How many times the window reset during the run. Stretches across a reset don't count. */
  resets: CountSchema,
});
export type WindowRate = z.infer<typeof WindowRateSchema>;

/** One vendor's tokens by kind over a run, and the windows they moved. */
export const VendorUsageSampleSchema = z.object({
  vendor: VendorSchema,
  /** Tokens of the calls that reported a breakdown, by kind. */
  fresh: CountSchema,
  cacheWrite: CountSchema,
  cacheRead: CountSchema,
  out: CountSchema,
  /** Every token of those calls, as `tokens.in` plus `tokens.out` counts them. */
  raw: CountSchema,
  windows: z.array(WindowRateSchema).max(3).default([]),
});
export type VendorUsageSample = z.input<typeof VendorUsageSampleSchema>;

/**
 * One finished run's measured tokens, reduced to what an estimate can match
 * on. It holds numbers and settings only, never a name, a path, or content,
 * so samples can pass between projects.
 */
export const RunTokenSampleSchema = z.object({
  runId: z.string().min(1).max(64),
  depth: RunDepthSchema,
  scope: z.enum(["whole", "range"]),
  /** The reviewer effort, or `default` for each vendor's own. */
  effort: z.string().min(1).max(16),
  readOnly: z.boolean(),
  /** How many groups the run had. */
  groups: CountSchema,
  /** The changed lines over every group. */
  lines: CountSchema.default(0),
  /** The files over every group. */
  files: CountSchema.default(0),
  /** Reviewer tokens, reviewed groups and their changed lines, by vendor and tier. */
  review: z
    .array(
      z.object({
        vendor: VendorSchema,
        tier: ModelTierSchema.nullable(),
        tokens: CountSchema,
        groups: CountSchema,
        lines: CountSchema.default(0),
        /** Each reviewed group as `[changed lines, tokens]`, when known. */
        points: z
          .array(z.tuple([CountSchema, CountSchema]))
          .max(TOKEN_SAMPLE_POINT_LIMIT)
          .optional(),
      }),
    )
    .max(16),
  /** Disprover, confirmer, and sweep tokens. */
  verificationTokens: CountSchema,
  fixingTokens: CountSchema,
  /**
   * Each vendor's tokens by kind and what they did to its usage windows.
   * Absent from a sample saved before the breakdown existed.
   */
  usage: z.array(VendorUsageSampleSchema).max(4).optional(),
});
export type RunTokenSample = z.input<typeof RunTokenSampleSchema>;

/**
 * The body of the engine's `engine.runs.preview`: the request plus the
 * samples of finished runs in the other projects on this host, which the
 * server reads, since the engine sees only its own project.
 */
export const EngineRunPreviewSchema = RunRequestFieldsSchema.extend({
  hostTokenSamples: z.array(RunTokenSampleSchema).max(HOST_TOKEN_SAMPLE_LIMIT).optional(),
})
  .superRefine(refuseReadOnlyPostPush)
  .transform(resolveRequest);
export type EngineRunPreview = z.infer<typeof EngineRunPreviewSchema>;

export interface TokenEstimateLine {
  label: string;
  tokens: number;
  low: number;
  high: number;
  /** Where the figures come from, for a person to read. */
  source: string;
}

export interface RunTokenEstimate {
  /** The estimated tokens of the whole run, to two significant figures. */
  tokens: number;
  low: number;
  high: number;
  /** What the number comes from, for a person to read. */
  basis: string;
  lines: TokenEstimateLine[];
  /**
   * Each vendor's share of the estimate. Verification and fixing are split
   * in proportion to each vendor's review tokens, since the estimate can't
   * know which vendor takes them.
   */
  byVendor: { vendor: Vendor; tokens: number; low: number; high: number }[];
  /** The estimated share of each vendor's usage windows. */
  windows: WindowShareLine[];
}

/** An estimated share of one vendor's usage window, as fractions where 1 is the whole window. */
export interface WindowShareLine {
  vendor: Vendor;
  window: SampleWindow;
  low: number;
  high: number;
  /** Whether finished runs measured the rate, rather than the rough starting rate. */
  measured: boolean;
  /** Where the figures come from, for a person to read. */
  source: string;
}

export interface RunTokenEstimateInput {
  depth: RunDepth;
  scope?: "whole" | "range";
  effort?: string | undefined;
  readOnly?: boolean;
  /** The reviewers in turn, as the groups take them. */
  reviewers?: readonly Vendor[];
  /**
   * The vendor that verifies each reviewer's findings. A reviewer left out
   * verifies its own findings.
   */
  verifiers?: Partial<Record<Vendor, Vendor>>;
  /** The vendor that fixes the findings. Without it, each reviewer fixes its own. */
  fixer?: Vendor;
  groups: readonly { tier?: ModelTier | undefined; changedLines: number }[];
  /** This project's finished runs. */
  history?: readonly RunTokenSample[];
  /** Finished runs in the other projects on this host. */
  hostHistory?: readonly RunTokenSample[];
}

type Origin = "project" | "host";

/** A sample with where it came from and how much it counts. */
interface Weighted {
  sample: RunTokenSample;
  origin: Origin;
  weight: number;
}

/** Which runs a figure comes from, and whether it was moved from another effort. */
interface Provenance {
  project: Set<string>;
  host: Set<string>;
  /** The effort ratio applied, and whether a measurement or the starting rates gave it. */
  adjusted?: { ratio: number; measured: boolean };
}

/** Reviewer tokens for one group: `base + perLine * changed lines`, with multipliers for the range. */
interface ReviewRate {
  base: number;
  perLine: number;
  low: number;
  high: number;
  from: Provenance | null;
}

/** `high`, `xhigh`, and `max` cost about the same, and so do the rest. */
function effortClass(effort: string): "high" | "base" {
  return effort === "high" || effort === "xhigh" || effort === "max" ? "high" : "base";
}

/** The starting ratio between `high` and lower efforts, from the whole-project rates. */
const STARTING_EFFORT_RATIO =
  STARTING_REVIEW_RATES.whole.medium.high / STARTING_REVIEW_RATES.whole.medium.base;

/**
 * The newest samples of each origin, weighted so that newer runs and this
 * project's runs count more. Run ids are ULIDs, so they sort by time.
 */
function weigh(samples: readonly RunTokenSample[], origin: Origin): Weighted[] {
  const newest = [...samples].sort((a, b) => b.runId.localeCompare(a.runId)).slice(0, SAMPLE_LIMIT);
  const factor = origin === "project" ? 1 : HOST_WEIGHT;
  return newest.map((sample, i) => ({ sample, origin, weight: factor * RECENCY_DECAY ** i }));
}

function provenance(used: readonly Weighted[]): Provenance {
  const from: Provenance = { project: new Set(), host: new Set() };
  for (const w of used) from[w.origin].add(w.sample.runId);
  return from;
}

/**
 * Picks the samples a figure comes from: this project's exact matches, joined
 * by other projects' exact matches while this project has few, else every
 * sample of the same depth and scope at any effort.
 */
function pickSamples(
  exact: { project: Weighted[]; host: Weighted[] },
  nearby: { project: Weighted[]; host: Weighted[] },
  usable: (w: Weighted) => boolean,
): { used: Weighted[]; exact: boolean } {
  const own = exact.project.filter(usable);
  if (own.length >= ENOUGH_RUNS) return { used: own, exact: true };
  const joined = [...own, ...exact.host.filter(usable)];
  if (joined.length > 0) return { used: joined, exact: true };
  return { used: [...nearby.project, ...nearby.host].filter(usable), exact: false };
}

/** The low and high multipliers from how far each run sits from the fitted figure. */
function spreadOf(
  ratios: readonly number[],
  single: { low: number; high: number },
): { low: number; high: number } {
  if (ratios.length < 2) return single;
  return {
    low: Math.min(1, ...ratios) * SAMPLE_MARGIN.low,
    high: Math.max(1, ...ratios) * SAMPLE_MARGIN.high,
  };
}

/**
 * Fits `tokens = base + perLine * lines` to weighted points by least squares.
 * When the points' sizes are too alike to show a slope, the slope is the prior
 * one. Neither figure goes below zero.
 */
function fitLine(points: readonly { lines: number; tokens: number; weight: number }[]): {
  base: number;
  perLine: number;
} {
  const total = points.reduce((n, p) => n + p.weight, 0);
  if (total <= 0) return { base: 0, perLine: 0 };
  const mx = points.reduce((n, p) => n + p.weight * p.lines, 0) / total;
  const my = points.reduce((n, p) => n + p.weight * p.tokens, 0) / total;
  if (mx <= 0) return { base: my, perLine: 0 };
  const sxx = points.reduce((n, p) => n + p.weight * (p.lines - mx) ** 2, 0);
  const sxy = points.reduce((n, p) => n + p.weight * (p.lines - mx) * (p.tokens - my), 0);
  // A spread of sizes under a tenth of the mean says little about the slope.
  const spread = Math.sqrt(sxx / total);
  const slope = spread >= mx * 0.1 && sxx > 0 ? sxy / sxx : PRIOR_PER_LINE;
  const perLine = Math.min(Math.max(slope, 0), my / mx);
  return { base: my - perLine * mx, perLine };
}

function twoFigures(n: number): number {
  return n === 0 ? 0 : Number(n.toPrecision(2));
}

function plural(n: number, word: string): string {
  return `${n} ${n === 1 ? word : `${word}s`}`;
}

/** Says which runs a figure comes from, for a person to read. */
function describe(from: Provenance): string {
  const parts = [
    ...(from.project.size > 0 ? [`${plural(from.project.size, "run")} in this project`] : []),
    ...(from.host.size > 0 ? [`${plural(from.host.size, "run")} in other projects`] : []),
  ];
  const adjusted = from.adjusted
    ? `, adjusted from another effort by ${from.adjusted.ratio.toFixed(2)} times (a ${from.adjusted.measured ? "measured" : "starting"} ratio)`
    : "";
  return `based on ${parts.join(" and ")}${adjusted}`;
}

/**
 * A rough token estimate for a run: reviewer tokens per group by vendor, tier,
 * effort and group size, plus verification and fixing as their own lines.
 *
 * Each figure comes from the first of these that has data: this project's runs
 * with the same depth, scope and effort (joined by other projects' matching
 * runs while this project has fewer than two), then runs of the same depth and
 * scope at another effort, moved by the ratio between the efforts, then the
 * starting rates, then, for a vendor or depth with none of these, the fallback
 * in `TOKEN_ESTIMATE`. Newer runs count more. Reviewer tokens are fitted as a
 * base per group plus a rate per changed line, so a policy with smaller groups
 * gets a smaller figure per group. Plain arithmetic: it calls no model, and it
 * can't know how many findings a run gets.
 */
export function estimateRunTokens(input: RunTokenEstimateInput): RunTokenEstimate {
  const scope = input.scope ?? "range";
  const effort = input.effort ?? "default";
  const reviewers = input.reviewers?.length ? input.reviewers : (["claude"] as const);
  const readOnly = input.readOnly ?? false;
  const fallback = TOKEN_ESTIMATE[input.depth];

  const sameRun = (s: RunTokenSample) => s.depth === input.depth && s.scope === scope;
  const split = (samples: readonly RunTokenSample[], origin: Origin) => {
    const alike = samples.filter(sameRun);
    return {
      exact: weigh(
        alike.filter((s) => s.effort === effort),
        origin,
      ),
      other: weigh(
        alike.filter((s) => s.effort !== effort),
        origin,
      ),
    };
  };
  const own = split(input.history ?? [], "project");
  const host = split(input.hostHistory ?? [], "host");
  const exact = { project: own.exact, host: host.exact };
  const nearby = { project: own.other, host: host.other };

  const entryOf = (s: RunTokenSample, vendor: Vendor, tier: ModelTier | null) =>
    s.review.find((r) => r.vendor === vendor && r.tier === tier && r.groups > 0);

  /** The ratio that moves a figure measured at `from` to this run's effort. */
  const effortRatio = (
    vendor: Vendor,
    tier: ModelTier | null,
    from: string,
  ): { ratio: number; measured: boolean } => {
    const target = effortClass(effort);
    const source = effortClass(from);
    if (target === source) return { ratio: 1, measured: false };
    const perGroupAt = (cls: "high" | "base") => {
      let tokens = 0;
      let groups = 0;
      for (const w of [...exact.project, ...exact.host, ...nearby.project, ...nearby.host]) {
        if (effortClass(w.sample.effort) !== cls) continue;
        const entry = entryOf(w.sample, vendor, tier);
        if (!entry) continue;
        tokens += entry.tokens;
        groups += entry.groups;
      }
      return groups > 0 ? tokens / groups : null;
    };
    const at = perGroupAt(target);
    const was = perGroupAt(source);
    if (at !== null && was !== null && was > 0) return { ratio: at / was, measured: true };
    const ratio = target === "high" ? STARTING_EFFORT_RATIO : 1 / STARTING_EFFORT_RATIO;
    return { ratio, measured: false };
  };

  const rates = new Map<string, ReviewRate | null>();
  const reviewRate = (vendor: Vendor, tier: ModelTier | undefined): ReviewRate | null => {
    const key = `${vendor}/${tier ?? null}`;
    if (rates.has(key)) return rates.get(key) ?? null;
    const rate = fitReview(vendor, tier ?? null);
    rates.set(key, rate);
    return rate;
  };
  const fitReview = (vendor: Vendor, tier: ModelTier | null): ReviewRate | null => {
    const picked = pickSamples(exact, nearby, (w) => entryOf(w.sample, vendor, tier) !== undefined);
    if (picked.used.length > 0) {
      const points: { lines: number; tokens: number; weight: number }[] = [];
      const runs: { weight: number; groups: number; lines: number; tokens: number }[] = [];
      let adjusted: Provenance["adjusted"];
      for (const w of picked.used) {
        const entry = entryOf(w.sample, vendor, tier);
        if (!entry) continue;
        const move = picked.exact
          ? { ratio: 1, measured: false }
          : effortRatio(vendor, tier, w.sample.effort);
        if (move.ratio !== 1) adjusted = move;
        const tokens = entry.tokens * move.ratio;
        const lines = entry.lines ?? 0;
        runs.push({ weight: w.weight, groups: entry.groups, lines, tokens });
        // Each group is a point. Without per-group points, the run's mean
        // group stands for all of them.
        if (entry.points?.length) {
          const each = (w.weight * entry.groups) / entry.points.length;
          for (const [l, t] of entry.points)
            points.push({ lines: l, tokens: t * move.ratio, weight: each });
        } else {
          points.push({
            lines: lines / entry.groups,
            tokens: tokens / entry.groups,
            weight: w.weight * entry.groups,
          });
        }
      }
      const fit = fitLine(points);
      const ratios = runs
        .map((r) => r.tokens / (fit.base * r.groups + fit.perLine * r.lines))
        .filter((r) => Number.isFinite(r));
      const spread = spreadOf(ratios, REVIEW_SPREAD);
      const from = provenance(picked.used);
      if (adjusted) from.adjusted = adjusted;
      return { ...fit, ...spread, from };
    }
    if (vendor !== "claude" || input.depth !== "standard") return null;
    const base =
      scope === "range"
        ? STARTING_REVIEW_RATES.range.perGroup
        : STARTING_REVIEW_RATES.whole[tier ?? "medium"][effortClass(effort)];
    return { base, perLine: 0, ...REVIEW_SPREAD, from: null };
  };

  let review = { tokens: 0, low: 0, high: 0 };
  let older = { tokens: 0, groups: 0, lines: 0 };
  const sources = new Map<string, number>();
  const perVendor = new Map<Vendor, { tokens: number; low: number; high: number }>();
  const addVendor = (vendor: Vendor, tokens: number, low: number, high: number) => {
    const v = perVendor.get(vendor) ?? { tokens: 0, low: 0, high: 0 };
    perVendor.set(vendor, { tokens: v.tokens + tokens, low: v.low + low, high: v.high + high });
  };
  // Review tokens of the groups that have their own verification and fixing
  // lines, by reviewer. Groups on the older rate already include those stages.
  const stagedReview = new Map<Vendor, number>();
  input.groups.forEach((group, index) => {
    const vendor = reviewers[index % reviewers.length] as Vendor;
    const rate = reviewRate(vendor, group.tier);
    if (!rate) {
      const tokens = fallback.perGroup + group.changedLines * fallback.perLine;
      addVendor(vendor, tokens, tokens * REVIEW_SPREAD.low, tokens * REVIEW_SPREAD.high);
      older = {
        tokens: older.tokens + tokens,
        groups: older.groups + 1,
        lines: older.lines + group.changedLines,
      };
      return;
    }
    const tokens = rate.base + rate.perLine * group.changedLines;
    addVendor(vendor, tokens, tokens * rate.low, tokens * rate.high);
    stagedReview.set(vendor, (stagedReview.get(vendor) ?? 0) + tokens);
    review = {
      tokens: review.tokens + tokens,
      low: review.low + tokens * rate.low,
      high: review.high + tokens * rate.high,
    };
    const source = rate.from ? describe(rate.from) : "at the starting rates";
    sources.set(source, (sources.get(source) ?? 0) + 1);
  });

  const lines: TokenEstimateLine[] = [];
  if (sources.size > 0) {
    lines.push({
      label: "Review",
      ...review,
      source: [...sources].map(([source, n]) => `${plural(n, "group")} ${source}`).join("; "),
    });
  }
  if (older.groups > 0) {
    lines.push({
      label: "Whole run, no measurements",
      tokens: older.tokens,
      low: older.tokens * REVIEW_SPREAD.low,
      high: older.tokens * REVIEW_SPREAD.high,
      source: `no runs measure this vendor or depth, so ${plural(older.groups, "group")} use the older rate of ${fallback.perGroup.toLocaleString("en-US")} tokens each plus ${fallback.perLine} per changed line, which includes verification and fixing`,
    });
  }

  // Groups on the older rate already include these stages.
  const staged = input.groups.length - older.groups;
  const stageLine = (
    label: string,
    pick: (s: RunTokenSample) => number,
    usable: (s: RunTokenSample) => boolean,
    starting: number,
  ): void => {
    if (staged === 0) return;
    // Findings drive these stages more than effort does, so a run at another
    // effort counts as it is.
    const picked = pickSamples(exact, nearby, (w) => w.sample.groups > 0 && usable(w.sample));
    let value = starting;
    let spread = FINDINGS_SPREAD;
    let source = "the starting rate, and findings move it the most";
    if (picked.used.length > 0) {
      const weight = picked.used.reduce((n, w) => n + w.weight * w.sample.groups, 0);
      value = picked.used.reduce((n, w) => n + w.weight * pick(w.sample), 0) / weight;
      const ratios = picked.used.map((w) => pick(w.sample) / w.sample.groups / value);
      spread = value > 0 ? spreadOf(ratios, FINDINGS_SPREAD) : FINDINGS_SPREAD;
      source = describe(provenance(picked.used));
    }
    lines.push({
      label,
      tokens: value * staged,
      low: value * spread.low * staged,
      high: value * spread.high * staged,
      source,
    });
  };
  stageLine(
    "Verification",
    (s) => s.verificationTokens,
    () => true,
    STARTING_STAGE_RATES.verification,
  );
  if (!readOnly) {
    stageLine(
      "Fixing",
      (s) => s.fixingTokens,
      (s) => !s.readOnly,
      STARTING_STAGE_RATES.fixing,
    );
  }

  const sum = (key: "tokens" | "low" | "high") => lines.reduce((n, l) => n + l[key], 0);
  const rounded = lines.map((l) => ({
    ...l,
    tokens: twoFigures(l.tokens),
    low: twoFigures(l.low),
    high: twoFigures(l.high),
  }));
  const changed = input.groups.reduce((n, g) => n + g.changedLines, 0);
  // Each stage line is split by each reviewer's share of the staged groups'
  // review tokens, then goes to the vendor that runs that stage for the
  // reviewer: its verifier, or the fixer.
  const reviewed = [...stagedReview.values()].reduce((n, t) => n + t, 0);
  for (const line of lines) {
    if (line.label !== "Verification" && line.label !== "Fixing") continue;
    for (const [reviewer, t] of stagedReview) {
      const share = reviewed > 0 ? t / reviewed : 0;
      const vendor =
        line.label === "Fixing"
          ? (input.fixer ?? reviewer)
          : (input.verifiers?.[reviewer] ?? reviewer);
      addVendor(vendor, share * line.tokens, share * line.low, share * line.high);
    }
  }
  const byVendor = [...perVendor].map(([vendor, v]) => ({
    vendor,
    tokens: twoFigures(v.tokens),
    low: twoFigures(v.low),
    high: twoFigures(v.high),
  }));
  return {
    tokens: twoFigures(sum("tokens")),
    low: twoFigures(sum("low")),
    high: twoFigures(sum("high")),
    basis: `${plural(input.groups.length, "group")} with ${changed.toLocaleString("en-US")} changed lines at the ${input.depth} depth. ${rounded.map((l) => `${l.label}: ${l.source}.`).join(" ")} Real runs can differ a lot, mostly with the number of findings.`,
    lines: rounded,
    byVendor,
    windows: estimateWindowShare(byVendor, input.history ?? [], input.hostHistory ?? []),
  };
}

/**
 * The rough rate for Claude's 5-hour window with no measured run, as a share
 * of the window per raw token (`tokens.in` plus `tokens.out`). It comes from
 * one observed whole-project run of 47.7 million tokens that used about 60%
 * of a 5-hour window. A smaller run, at 35 million tokens, used about 10%
 * partway through, so the low end reaches well below the rate.
 */
export const STARTING_WINDOW_RATE = {
  vendor: "claude",
  window: "5h",
  perRawToken: 0.6 / 47_700_000,
  low: 0.25,
  high: 1.5,
} as const;
/** The margins around one measured rate. */
const WINDOW_SPREAD_SINGLE = { low: 0.5, high: 2 };

/**
 * Estimates the share of each vendor's usage windows that a run takes, from
 * the vendor's token estimate and the rates finished runs measured.
 *
 * A measured rate is the share of a window used per weighted token. Moving
 * from the estimate's raw tokens to weighted tokens uses the ratio the same
 * runs measured. Every rate includes any other use of the account during
 * those runs, such as an interactive session, so a measured rate errs high,
 * and the share it gives is conservative. With no measured run, Claude's
 * 5-hour window gets the rough `STARTING_WINDOW_RATE`, labeled as such; other
 * vendors and windows get no line until a run measures them.
 */
export function estimateWindowShare(
  byVendor: readonly { vendor: Vendor; tokens: number; low: number; high: number }[],
  history: readonly RunTokenSample[],
  hostHistory: readonly RunTokenSample[],
): WindowShareLine[] {
  const out: WindowShareLine[] = [];
  const weighted = [...weigh(history, "project"), ...weigh(hostHistory, "host")];
  for (const est of byVendor) {
    if (est.tokens <= 0) continue;
    const measured = new Map<
      SampleWindow,
      { w: Weighted; usage: VendorUsageSample; rate: WindowRate }[]
    >();
    for (const w of weighted) {
      const usage = w.sample.usage?.find((u) => u.vendor === est.vendor);
      if (!usage || usage.raw <= 0) continue;
      for (const rate of usage.windows ?? []) {
        // A window that didn't move a visible step measures no rate: vendors
        // report use in coarse steps, so a zero says only that the share was
        // under one step.
        if (rate.weighted <= 0 || rate.used <= 0) continue;
        const list = measured.get(rate.window) ?? [];
        list.push({ w, usage, rate });
        measured.set(rate.window, list);
      }
    }
    for (const [window, runs] of measured) {
      // Pooled over runs, so a run with more tokens counts more.
      let used = 0;
      let weightedSum = 0;
      let weightedOfRaw = 0;
      let raw = 0;
      for (const { w, usage, rate } of runs) {
        used += w.weight * rate.used;
        weightedSum += w.weight * rate.weighted;
        weightedOfRaw += w.weight * weightedTokensOf(est.vendor, usage);
        raw += w.weight * usage.raw;
      }
      if (weightedSum <= 0 || raw <= 0) continue;
      const rate = used / weightedSum;
      const ratio = weightedOfRaw / raw;
      const spread = spreadOf(
        runs.map((r) => r.rate.rate / rate).filter((r) => Number.isFinite(r)),
        WINDOW_SPREAD_SINGLE,
      );
      const from = provenance(runs.map((r) => r.w));
      out.push({
        vendor: est.vendor,
        window,
        low: est.low * ratio * rate * spread.low,
        high: est.high * ratio * rate * spread.high,
        measured: true,
        source: `${describe(from)}, which include any other use of the account at the time, so the share errs high`,
      });
    }
    const start = STARTING_WINDOW_RATE;
    if (est.vendor === start.vendor && !measured.has(start.window)) {
      out.push({
        vendor: est.vendor,
        window: start.window,
        low: est.low * start.perRawToken * start.low,
        high: est.high * start.perRawToken * start.high,
        measured: false,
        source:
          "rough, no measurements yet: from one observed run of 47.7 million tokens that used about 60% of the window",
      });
    }
  }
  return out;
}

function weightedTokensOf(vendor: Vendor, usage: VendorUsageSample): number {
  return weightedTokens(vendor, {
    fresh: usage.fresh,
    cacheWrite: usage.cacheWrite,
    cacheRead: usage.cacheRead,
    out: usage.out,
  });
}

const WINDOW_NAMES: Record<SampleWindow, string> = {
  "5h": "5-hour",
  "7d": "7-day",
  month: "monthly",
};
const VENDOR_NAMES: Record<Vendor, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
};

/** A share as a whole percent: one figure under 10%, else to the nearest 5%. */
function percent(share: number): number {
  const p = share * 100;
  return p < 10 ? Math.max(1, Math.round(p)) : Math.round(p / 5) * 5;
}

/**
 * One window share as a sentence fragment, such as "about 15 to 25% of your
 * 5-hour Claude window", with a "(rough, no measurements yet)" suffix for the
 * starting rate.
 */
export function describeWindowShare(
  line: Pick<WindowShareLine, "vendor" | "window" | "low" | "high" | "measured">,
): string {
  const name = `your ${WINDOW_NAMES[line.window]} ${VENDOR_NAMES[line.vendor]} window`;
  const rough = line.measured ? "" : " (rough, no measurements yet)";
  if (line.low >= 1) return `more than all of ${name}${rough}`;
  if (line.high < 0.01) return `under 1% of ${name}${rough}`;
  if (line.high >= 1) {
    const from = line.low < 0.01 ? "under 1" : String(percent(line.low));
    return `from ${from}% to more than all of ${name}${rough}`;
  }
  const high = String(percent(line.high));
  if (line.low < 0.01) return `up to ${high}% of ${name}${rough}`;
  const low = String(percent(line.low));
  const range = low === high ? `${low}%` : `${low} to ${high}%`;
  return `about ${range} of ${name}${rough}`;
}
