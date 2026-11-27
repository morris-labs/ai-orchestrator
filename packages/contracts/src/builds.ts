// Build pipeline execution: the build plan the engine carries out, the build
// request, and the build's saved state. See `docs/build-pipeline/design.md`.
//
// The full build plan holds what planning produced: the Analyst's spec (the
// stories, edge cases, criteria with their verification methods, size, usage
// estimate, secrets, and services), the Architect's design (the
// architecture, shared files, milestones, and task graph with specialties),
// the setup, test, type check, and lint commands, the issue the plan starts from,
// and the owner's push answer. Execution reads the criteria, the tasks, and
// the commands, and runs the tasks in dependency order.
import { z } from "zod";
import {
  CommitShaSchema,
  CountSchema,
  EnvVarNameSchema,
  IsoDateTimeSchema,
  RunIdSchema,
  VendorSchema,
} from "./common.js";
import {
  BuildIdSchema,
  BuildSlugSchema,
  BuildStatusSchema,
  BuildStepSchema,
  BuildTaskStatusSchema,
  type BuildStatus,
} from "./build-events.js";
import { RoleNameSchema } from "./build-roles.js";
import { DecisionAnswerSchema } from "./runs.js";
import { BuildPlacementsSchema, PlacementOverrideSchema } from "./placements.js";
import { PolicyCommandSchema } from "./policy.js";
import { TaskSpecialtiesSchema } from "./specialties.js";
import { cycleMessage, dependencyCycle } from "./task-graph.js";

/** An ID in the build plan, such as `AC2` or `T1`. */
export const PlanIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/, {
  message: "use letters, digits, `_`, `.`, and `-`, at most 32 characters",
});

/** How a criterion gets proven: an automated test, a UI check, or a manual owner check. */
export const VerificationMethodSchema = z.enum(["test", "ui", "owner"]);
export type VerificationMethod = z.infer<typeof VerificationMethodSchema>;

export const BuildCriterionSchema = z
  .object({
    id: PlanIdSchema,
    text: z.string().min(1),
    verification: VerificationMethodSchema.default("test"),
    /**
     * True when the criterion holds before the build, such as a behavior
     * that the change must keep. Its tests can pass the red check.
     */
    alreadyHolds: z.boolean().default(false),
  })
  .strict();
export type BuildCriterion = z.infer<typeof BuildCriterionSchema>;

const RepoPathSchema = z.string().min(1);

/**
 * The build size, which sets the steps that run: a small build skips the
 * coverage check, for example. See "Build size" in the design.
 */
export const BuildSizeSchema = z.enum(["small", "medium", "large"]);
export type BuildSize = z.infer<typeof BuildSizeSchema>;

/**
 * How a build runs: `pipeline` through the full build team, or
 * `single_session` as one Developer session plus one review run. See
 * "Flow" in the design.
 */
export const BuildFlowSchema = z.enum(["pipeline", "single_session"]);
export type BuildFlow = z.infer<typeof BuildFlowSchema>;

/** A flow as the owner reads it: `pipeline` or `single session`. */
export function buildFlowText(flow: BuildFlow): string {
  return flow === "single_session" ? "single session" : "pipeline";
}

/**
 * The Analyst's flow recommendation. A task is high-risk when it changes
 * stored data, runs a migration, or crosses an account or security boundary
 * across several packages.
 */
export const FlowRecommendationSchema = z
  .object({
    /** The flow the Analyst recommends. */
    flow: BuildFlowSchema,
    /** Whether the task is high-risk. */
    highRisk: z.boolean(),
    /** Why the task is or isn't high-risk, in one or two sentences. */
    reason: z.string().min(1),
  })
  .strict();
export type FlowRecommendation = z.infer<typeof FlowRecommendationSchema>;

/**
 * An open question in the Analyst's spec, with the answer the Analyst
 * recommends. The Project manager takes the recommended answer for a
 * question that changes no acceptance criterion, and asks the owner the
 * rest.
 */
export const BuildQuestionSchema = z
  .object({
    /** The question, in one sentence. */
    question: z.string().min(1),
    /** The answer the Analyst recommends, in one or two sentences. */
    recommendedAnswer: z.string().min(1),
    /** Whether an answer other than the recommended one would change an acceptance criterion. */
    changesCriterion: z.boolean(),
  })
  .strict();
export type BuildQuestion = z.infer<typeof BuildQuestionSchema>;

/**
 * The flow the size threshold gives: `single_session` for a small or medium
 * task that isn't high-risk, and `pipeline` for any other.
 */
export function thresholdFlow(size: BuildSize, highRisk: boolean): BuildFlow {
  return size !== "large" && !highRisk ? "single_session" : "pipeline";
}

/**
 * The most tasks a build plan of each size can have, or `null` for no limit.
 * Each task costs a cold Developer start, so a smaller build gets fewer. The
 * Contracts step doesn't count as a task.
 */
export const TASK_LIMITS: Readonly<Record<BuildSize, number | null>> = {
  small: 1,
  medium: 5,
  large: null,
};

/**
 * The task limit of `size` as a clause, such as "a medium build has at most 5
 * tasks", or `null` for a size without a limit.
 */
export function taskLimitText(size: BuildSize): string | null {
  const limit = TASK_LIMITS[size];
  if (limit === null) return null;
  return `a ${size} build has at most ${limit} ${limit === 1 ? "task" : "tasks"}`;
}

export const BuildTaskSchema = z
  .object({
    id: PlanIdSchema,
    title: z.string().min(1),
    description: z.string().min(1),
    /** The role whose seat works the task. */
    role: RoleNameSchema.default("developer"),
    /** Repository-relative paths or globs that the task may change. */
    ownedFiles: z.array(RepoPathSchema).min(1),
    /** Contract files that the task implements. */
    contracts: z.array(RepoPathSchema).default([]),
    /** IDs of the criteria that the task serves. */
    criteria: z.array(PlanIdSchema).min(1),
    /** The test files that must pass. */
    tests: z.array(RepoPathSchema).default([]),
    /** The specialties whose guidance every agent on the task gets. */
    specialties: TaskSpecialtiesSchema,
    /** The IDs of the tasks that must finish before this task starts. */
    dependsOn: z.array(PlanIdSchema).default([]),
  })
  .strict();
export type BuildTask = z.infer<typeof BuildTaskSchema>;

/**
 * The commands the task gate runs, which the Project manager seeds from the
 * policy file. Preflight runs the `setup` commands once, before every other
 * command, to make the fresh build worktree ready: to install its
 * dependencies, for example.
 */
export const BuildCommandsSchema = z
  .object({
    setup: z.array(PolicyCommandSchema).default([]),
    test: z.array(PolicyCommandSchema).min(1, "the plan needs at least one test command"),
    typecheck: z.array(PolicyCommandSchema).default([]),
    lint: z.array(PolicyCommandSchema).default([]),
  })
  .strict();
export type BuildCommands = z.infer<typeof BuildCommandsSchema>;

/** The GitHub issue a build plan starts from. `url` links back to it. */
export const BuildIssueSchema = z
  .object({
    /** The repository, as `owner/name`. */
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, {
      message: "name the repository as owner/name",
    }),
    number: z.number().int().positive(),
    /** The issue's page. Absent means the issue's page on github.com. */
    url: z.string().url().optional(),
  })
  .strict()
  .transform((issue) => ({
    ...issue,
    url: issue.url ?? `https://github.com/${issue.repository}/issues/${issue.number}`,
  }));
export type BuildIssue = z.infer<typeof BuildIssueSchema>;
export type BuildIssueInput = z.input<typeof BuildIssueSchema>;

/** The usage a build is expected to spend, in tokens. */
export const UsageEstimateSchema = z
  .object({ low: CountSchema, high: CountSchema })
  .strict()
  .refine((estimate) => estimate.low <= estimate.high, {
    message: "the low end of the usage estimate is over its high end",
    path: ["low"],
  });
export type UsageEstimate = z.infer<typeof UsageEstimateSchema>;

/** A secret the build needs, by the name `aio-secret` gives it. */
export const BuildSecretSchema = z
  .object({ name: EnvVarNameSchema, purpose: z.string().min(1) })
  .strict();
export type BuildSecret = z.infer<typeof BuildSecretSchema>;

/** An external service the build needs. */
export const BuildServiceSchema = z
  .object({ name: z.string().min(1), purpose: z.string().min(1) })
  .strict();
export type BuildService = z.infer<typeof BuildServiceSchema>;

/** The spec's prose: what the build delivers, as stories and edge cases. */
export const BuildSpecTextSchema = z
  .object({
    summary: z.string().min(1),
    stories: z.array(z.string().min(1)).min(1),
    edgeCases: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type BuildSpecText = z.infer<typeof BuildSpecTextSchema>;

/** A milestone: a working and tested increment, and the tasks that build it. */
export const BuildMilestoneSchema = z
  .object({
    id: PlanIdSchema,
    title: z.string().min(1),
    /** What works when the milestone is done. */
    goal: z.string().min(1),
    /** The IDs of the milestone's tasks. */
    tasks: z.array(PlanIdSchema).min(1),
  })
  .strict();
export type BuildMilestone = z.infer<typeof BuildMilestoneSchema>;

/** Adds an issue for each dependency on a task the list lacks, and for a dependency cycle. */
function checkTaskGraph(tasks: readonly BuildTask[], ctx: z.RefinementCtx): void {
  const ids = new Set(tasks.map((t) => t.id));
  tasks.forEach((task, i) => {
    for (const id of task.dependsOn.filter((d) => !ids.has(d))) {
      ctx.addIssue({
        code: "custom",
        path: ["tasks", i, "dependsOn"],
        message: `task ${task.id} depends on ${id}, which the plan doesn't have`,
      });
    }
  });
  const cycle = dependencyCycle(tasks);
  if (cycle) ctx.addIssue({ code: "custom", path: ["tasks"], message: cycleMessage(cycle) });
}

/** Adds an issue for each milestone task the task list lacks, and each task in two milestones. */
function checkMilestones(
  milestones: readonly BuildMilestone[],
  tasks: readonly { id: string }[],
  ctx: z.RefinementCtx,
): void {
  const known = new Set(tasks.map((t) => t.id));
  const placed = new Set<string>();
  milestones.forEach((milestone, i) => {
    for (const id of milestone.tasks) {
      if (!known.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["milestones", i, "tasks"],
          message: `milestone ${milestone.id} names task ${id}, which the plan doesn't have`,
        });
      } else if (placed.has(id)) {
        ctx.addIssue({
          code: "custom",
          path: ["milestones", i, "tasks"],
          message: `task ${id} is in more than one milestone`,
        });
      }
      placed.add(id);
    }
  });
}

/**
 * The Analyst's answer: the spec. Each criterion names its verification
 * method; the size and the usage estimate are the Analyst's estimates, which
 * the owner can change.
 */
export const BuildSpecSchema = BuildSpecTextSchema.extend({
  /** The build plan's title. */
  title: z.string().min(1),
  criteria: z.array(BuildCriterionSchema.extend({ verification: VerificationMethodSchema })).min(1),
  size: BuildSizeSchema,
  usageEstimate: UsageEstimateSchema,
  secrets: z.array(BuildSecretSchema).default([]),
  services: z.array(BuildServiceSchema).default([]),
  /** The flow the Analyst recommends, which the owner can override either way. */
  recommendation: FlowRecommendationSchema,
  /** The open questions, each with a recommended answer and a criterion flag. */
  questions: z.array(BuildQuestionSchema).default([]),
})
  .strict()
  .superRefine((spec, ctx) => {
    const { flow, highRisk } = spec.recommendation;
    const expected = thresholdFlow(spec.size, highRisk);
    if (flow !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["recommendation", "flow"],
        message: `a ${spec.size} task that is ${highRisk ? "" : "not "}high-risk gets the ${expected} flow, not ${flow}`,
      });
    }
    for (const id of duplicates(spec.criteria.map((c) => c.id))) {
      ctx.addIssue({
        code: "custom",
        path: ["criteria"],
        message: `criterion ${id} is listed twice`,
      });
    }
  });
export type BuildSpec = z.infer<typeof BuildSpecSchema>;

/** The Architect's answer: the architecture, the shared files, the milestones, and the task graph. */
export const BuildDesignSchema = z
  .object({
    /** The architecture, in Markdown. */
    architecture: z.string().min(1),
    /** Files that several tasks read or change, such as shared types. */
    sharedFiles: z.array(RepoPathSchema).default([]),
    milestones: z.array(BuildMilestoneSchema).min(1),
    tasks: z.array(BuildTaskSchema).min(1),
  })
  .strict()
  .superRefine((design, ctx) => {
    for (const id of duplicates(design.tasks.map((t) => t.id))) {
      ctx.addIssue({ code: "custom", path: ["tasks"], message: `task ${id} is listed twice` });
    }
    checkTaskGraph(design.tasks, ctx);
    checkMilestones(design.milestones, design.tasks, ctx);
  });
export type BuildDesign = z.infer<typeof BuildDesignSchema>;

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(ids.filter((id) => seen.size === seen.add(id).size))];
}

/** A planning question that the Project manager answered with the Analyst's recommended answer. */
export const BuildDefaultedAnswerSchema = z
  .object({
    question: z.string().min(1),
    answer: z.string().min(1),
  })
  .strict();
export type BuildDefaultedAnswer = z.infer<typeof BuildDefaultedAnswerSchema>;

export const BuildPlanSchema = z
  .object({
    /** The plan's version; a revised plan gets the next one. */
    version: z.number().int().positive().default(1),
    title: z.string().min(1),
    /** The build size, which the Analyst estimates and the owner can change. */
    size: BuildSizeSchema.default("medium"),
    /** The GitHub issue the plan starts from, or `null` for a request in the owner's words. */
    issue: BuildIssueSchema.nullable().default(null),
    /** The Analyst's stories and edge cases. */
    spec: BuildSpecTextSchema.nullable().default(null),
    usageEstimate: UsageEstimateSchema.nullable().default(null),
    /** The secrets the build needs, which the owner ticks for the project before approval. */
    secrets: z.array(BuildSecretSchema).default([]),
    services: z.array(BuildServiceSchema).default([]),
    // Both flow fields are optional rather than defaulted, so that a plan
    // frozen before them keeps its hash.
    /** The Analyst's flow recommendation. Absent or `null` for a plan without one. */
    recommendation: FlowRecommendationSchema.nullable().optional(),
    /**
     * The owner's flow choice, which can override the recommendation either
     * way. Absent or `null` means nobody asked the owner yet, and a freeze
     * needs it. A frozen plan without it runs as a pipeline build.
     */
    flow: BuildFlowSchema.nullable().optional(),
    criteria: z.array(BuildCriterionSchema).min(1),
    /** The Architect's architecture, in Markdown. */
    architecture: z.string().min(1).nullable().default(null),
    sharedFiles: z.array(RepoPathSchema).default([]),
    milestones: z.array(BuildMilestoneSchema).default([]),
    tasks: z.array(BuildTaskSchema).min(1),
    commands: BuildCommandsSchema,
    /** Places every seat on this vendor. `null` leaves each seat on its own placement. */
    singleVendor: VendorSchema.nullable().default(null),
    /** Placement overrides by seat, over the role defaults and the single-vendor setting. */
    placements: z.record(RoleNameSchema, PlacementOverrideSchema).default({}),
    /**
     * The owner's push answer: `true` lets the build push its branch and open
     * its pull request, and `false` keeps the branch local. `null` means
     * nobody asked the owner yet, and the build stops at an escalation before
     * the push. A freeze needs it.
     */
    push: z.boolean().nullable().default(null),
    /**
     * How many direct messages each agent can send the owner in one
     * milestone. Absent means `DIRECT_MESSAGE_LIMIT`.
     */
    directMessagesPerMilestone: z.number().int().min(0).max(100).optional(),
    /**
     * How many questions each agent can ask about one task before a further
     * question goes to the Project manager as an escalation. Absent means
     * `QUESTION_CAP`.
     */
    questionsPerTask: z.number().int().min(0).max(100).optional(),
    /**
     * The planning questions that the Project manager answered with the
     * Analyst's recommended answer instead of asking the owner. Absent
     * means none.
     */
    defaultedAnswers: z.array(BuildDefaultedAnswerSchema).optional(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    for (const id of duplicates(plan.criteria.map((c) => c.id))) {
      ctx.addIssue({
        code: "custom",
        path: ["criteria"],
        message: `criterion ${id} is listed twice`,
      });
    }
    for (const id of duplicates(plan.tasks.map((t) => t.id))) {
      ctx.addIssue({ code: "custom", path: ["tasks"], message: `task ${id} is listed twice` });
    }
    const known = new Set(plan.criteria.map((c) => c.id));
    plan.tasks.forEach((task, i) => {
      for (const id of task.criteria.filter((c) => !known.has(c))) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", i, "criteria"],
          message: `task ${task.id} names criterion ${id}, which the plan doesn't have`,
        });
      }
    });
    checkTaskGraph(plan.tasks, ctx);
    checkMilestones(plan.milestones, plan.tasks, ctx);
  });
export type BuildPlan = z.infer<typeof BuildPlanSchema>;
export type BuildPlanInput = z.input<typeof BuildPlanSchema>;

/** What a draft plan takes beyond the planning seats' answers. */
export interface BuildPlanExtras {
  commands: z.input<typeof BuildCommandsSchema>;
  issue?: BuildIssueInput | null;
  push?: boolean | null;
}

/**
 * Drafts the full build plan from the Analyst's spec and the Architect's
 * design. The draft is input for `BuildPlanSchema`, which the freeze
 * applies, so the owner and the Project manager can still change it.
 */
export function draftBuildPlan(
  spec: BuildSpec,
  design: BuildDesign,
  extras: BuildPlanExtras,
): BuildPlanInput {
  const defaulted = defaultedAnswers(spec.questions);
  return {
    title: spec.title,
    issue: extras.issue ?? null,
    spec: { summary: spec.summary, stories: spec.stories, edgeCases: spec.edgeCases },
    size: spec.size,
    usageEstimate: spec.usageEstimate,
    secrets: spec.secrets,
    services: spec.services,
    recommendation: spec.recommendation,
    flow: null,
    criteria: spec.criteria,
    architecture: design.architecture,
    sharedFiles: design.sharedFiles,
    milestones: design.milestones,
    tasks: design.tasks,
    commands: extras.commands,
    push: extras.push ?? null,
    // Absent rather than empty, so that a plan without questions keeps its hash.
    ...(defaulted.length > 0 ? { defaultedAnswers: defaulted } : {}),
  };
}

/**
 * The answers that the Project manager takes by default: the recommended
 * answer of each question that changes no acceptance criterion.
 */
export function defaultedAnswers(questions: readonly BuildQuestion[]): BuildDefaultedAnswer[] {
  return questions
    .filter((q) => !q.changesCriterion)
    .map((q) => ({ question: q.question, answer: q.recommendedAnswer }));
}

/** A request to start a build. */
export const BuildCreateSchema = z
  .object({
    /** The project the build belongs to, as the server knows it. */
    projectId: z.string().min(1),
    /** The box whose session plans and watches the build, when one does. */
    boxId: z.string().min(1).optional(),
    slug: BuildSlugSchema,
    /** The build plan. Absent means the build's latest frozen plan. */
    plan: BuildPlanSchema.optional(),
    /** The repository as the container sees it. Absent means the project root. */
    repoPath: z.string().min(1).optional(),
    /** The branch, tag, or commit the build branch starts from. Absent means `HEAD`. */
    base: z.string().min(1).optional(),
  })
  .strict();
export type BuildCreate = z.infer<typeof BuildCreateSchema>;
export type BuildCreateInput = z.input<typeof BuildCreateSchema>;

/** Build statuses that keep the container alive: the engine works on the build. */
export const ACTIVE_BUILD_STATUSES: readonly BuildStatus[] = ["running"];

/**
 * Build statuses that hold a box: a box runs at most one build in one of
 * these, so a second build in the box is refused. A finished, failed, or
 * cancelled build frees its box.
 */
export const BOX_BUILD_STATUSES: readonly BuildStatus[] = [
  "planning",
  "running",
  "paused",
  "waiting_escalation",
];

/**
 * Who paused a build: `owner` for a request, such as from the owner or the
 * Project manager, and `box` when the build's box stopped. A box start
 * resumes only a build that its box's stop paused.
 */
export const BuildPauseReasonSchema = z.enum(["owner", "box"]);
export type BuildPauseReason = z.infer<typeof BuildPauseReasonSchema>;

/**
 * What paused a build: a request (`owner`), a box stop (`box`), or a
 * resolution that names an engine defect (`engine_defect`). Only the owner's
 * resume ends an engine defect pause, once a separate session fixed the
 * engine.
 */
export const BuildPausedBySchema = z.enum(["owner", "box", "engine_defect"]);
export type BuildPausedBy = z.infer<typeof BuildPausedBySchema>;

/** The body of a pause or resume request to the engine. */
export const BuildControlSchema = z
  .object({ reason: BuildPauseReasonSchema.default("owner") })
  .strict();
export type BuildControl = z.infer<typeof BuildControlSchema>;
export type BuildControlInput = z.input<typeof BuildControlSchema>;

/** The closing record that the Scribe writes when a build is cancelled, relative to the build directory. */
export const BUILD_CLOSING_RECORD = "closing-record.md";

export const BuildTaskProgressSchema = z.object({
  id: PlanIdSchema,
  status: BuildTaskStatusSchema,
  /** Attempts started so far. */
  attempts: z.number().int().nonnegative(),
  /** The commit the task started from; the permission check covers every change since. */
  base: CommitShaSchema.optional(),
  /** The build branch's commit after the task passed. */
  commit: CommitShaSchema.nullable(),
  /** Why the last attempt failed, in one line. */
  lastFailure: z.string().optional(),
  /**
   * The last attempt the task gets. Absent means the engine's attempt cap;
   * a retry after an escalation raises it.
   */
  attemptCap: z.number().int().positive().optional(),
  /** The attempt the task goes on with after a resolved escalation. */
  resumeAt: z.number().int().positive().optional(),
  /**
   * The patch of the task's work that the engine set aside while the task
   * waited for an escalation and other tasks ran, relative to the build
   * directory. The task's next attempt starts with it.
   */
  setAside: z.string().min(1).optional(),
});
export type BuildTaskProgress = z.infer<typeof BuildTaskProgressSchema>;

/**
 * The Contracts step's progress. A small build, and a plan whose tasks list
 * no contract files, skip the step.
 */
export const BuildContractsProgressSchema = z.object({
  status: z.enum(["running", "done", "failed", "skipped"]),
  /** The attempts that started. */
  attempts: z.number().int().nonnegative(),
  /** The commit that holds the contracts and their stubs, once the step is done. */
  commit: CommitShaSchema.optional(),
  /** The last gate failure, in one line. */
  lastFailure: z.string().optional(),
  /** The last attempt the step gets; absent means `ATTEMPT_CAP` in the engine. */
  attemptCap: z.number().int().positive().optional(),
});
export type BuildContractsProgress = z.infer<typeof BuildContractsProgressSchema>;

/** What raised an escalation. */
export const EscalationKindSchema = z.enum([
  /** A task failed the task gate on every attempt it has. */
  "attempt_cap",
  /** The Contracts step's Developer failed the task gate on every attempt it has. */
  "contracts",
  /** An agent call failed, was refused, or needs a person, such as a limit with no reset. */
  "agent_call",
  /** A seat's placement breaks a rule, such as a vendor that the single-vendor setting excludes. */
  "placement",
  /** A task's specialty can't be loaded, such as one whose skill was removed. */
  "specialty",
  /**
   * The build's review run needs a decision, or ended without reporting the
   * diff clean, such as at its round cap or with findings left for a person.
   */
  "review",
  /** A test, type check, or lint command of the build plan can't run at preflight. */
  "preflight",
  /**
   * Tests first can't lock the tests, such as tests that fail the red check
   * in every round, or revised tests that fail it after the coverage check.
   */
  "tests_first",
  /**
   * The build can't become release ready: a criterion without a passing
   * test, no recorded push answer, or a pull request whose checks don't pass.
   */
  "release_ready",
  /** A task broke a test that an earlier task made pass, on a second attempt after the first. */
  "oscillation",
  /** The build needs a secret that the project doesn't give it. */
  "missing_secret",
  /** The build needs an external service that it can't reach. */
  "missing_service",
  /**
   * An agent asked more questions about a task than the build plan's
   * question cap allows. The question past the cap goes to the Project
   * manager with the escalation.
   */
  "question_cap",
  /**
   * A test dispute that the Test engineer doesn't settle: a second dispute
   * about one test or a third in one task, which the Project manager rules
   * on, or an amendment that changes what a criterion means, which the
   * owner decides.
   */
  "test_dispute",
  /**
   * The work that a waiting task set aside no longer applies on top of the
   * tasks that ran since. The patch stays in the task's directory.
   */
  "set_aside",
]);
export type EscalationKind = z.infer<typeof EscalationKindSchema>;

/** Who resolves an escalation. */
export const EscalationLevelSchema = z.enum(["project_manager", "owner"]);
export type EscalationLevel = z.infer<typeof EscalationLevelSchema>;

/** Whether an escalation still waits for a decision. */
export const EscalationStatusSchema = z.enum(["open", "resolved"]);
export type EscalationStatus = z.infer<typeof EscalationStatusSchema>;

/**
 * What a resolution does:
 *
 * - `retry`: runs the paused work again. A task gets a new set of attempts.
 * - `reorder`: sets a new order for the tasks that aren't done, then retries.
 * - `clarify`: adds a clarification that the plan already implies to the
 *   task's context, then retries.
 * - `decide`: answers the decision that the build's review run waits for,
 *   then retries.
 * - `escalate`: hands the escalation to the owner, with a note that says why.
 */
export const EscalationActionSchema = z.enum(["retry", "reorder", "clarify", "decide", "escalate"]);
export type EscalationAction = z.infer<typeof EscalationActionSchema>;

/**
 * Why an escalation happened, when the resolver knows it isn't the task's
 * own problem. `engine_defect`: a defect in the engine raised it, so the
 * build pauses and a separate session fixes the engine.
 */
export const EscalationCauseSchema = z.enum(["engine_defect"]);
export type EscalationCause = z.infer<typeof EscalationCauseSchema>;

/** A part of the build plan that a resolution changes. */
export const PlanChangeSchema = z.enum([
  "criteria",
  "scope",
  "milestones",
  "contracts",
  "architecture",
]);
export type PlanChange = z.infer<typeof PlanChangeSchema>;

/**
 * The plan changes that only the owner decides. The Project manager can
 * approve a change to contracts or architecture after a planning meeting.
 */
export const OWNER_PLAN_CHANGES: readonly PlanChange[] = ["criteria", "scope", "milestones"];

const resolutionFields = {
  action: EscalationActionSchema,
  /** Who decided: the Project manager, or the owner, whose answer the Project manager relays. */
  by: EscalationLevelSchema.default("project_manager"),
  /** Why, or the clarification itself for `clarify`. */
  note: z.string().min(1).optional(),
  /** With `reorder`: the task IDs in the order they run. */
  order: z.array(PlanIdSchema).min(1).optional(),
  /** With `decide`: the answer to the review run's decision. */
  decision: DecisionAnswerSchema.optional(),
  /** For a release ready escalation: the owner's push answer, which the build plan records. */
  push: z.boolean().optional(),
  /** The parts of the build plan that the decision changes. */
  changes: z.array(PlanChangeSchema).default([]),
  /**
   * With `retry` or `clarify` for an escalation with a task: files or globs
   * that the task may change from now on, added to its owned files in the
   * build plan, such as a file that the plan left out of every task.
   */
  own: z.array(RepoPathSchema).min(1).optional(),
  /**
   * What caused the escalation. With `engine_defect`, the engine writes the
   * note to an engine defect note and pauses the build until the owner
   * resumes it. Needs `note`, and an action other than `escalate`.
   */
  cause: EscalationCauseSchema.optional(),
};

/** Adds an issue for each field that a resolution's action needs and lacks. */
export function checkEscalationResolve(
  r: {
    action: EscalationAction;
    note?: string;
    order?: string[];
    decision?: unknown;
    cause?: EscalationCause;
  },
  ctx: z.RefinementCtx,
): void {
  if (r.cause === "engine_defect" && r.note === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["note"],
      message: "an engine defect needs note, which describes the defect",
    });
  }
  if (r.cause === "engine_defect" && r.action === "escalate") {
    ctx.addIssue({
      code: "custom",
      path: ["cause"],
      message: "an engine defect pauses the build for the owner already: use another action",
    });
  }
  const needs: Partial<Record<EscalationAction, "note" | "order" | "decision">> = {
    reorder: "order",
    clarify: "note",
    decide: "decision",
    escalate: "note",
  };
  const field = needs[r.action];
  if (field && r[field] === undefined) {
    ctx.addIssue({ code: "custom", path: [field], message: `${r.action} needs ${field}` });
  }
}

/** The fields of a resolve request, before the check that each action has what it needs. */
export const EscalationResolveFieldsSchema = z
  .object({ escalation: PlanIdSchema, ...resolutionFields })
  .strict();

/** A resolve request: how to resolve one escalation of a build. */
export const EscalationResolveSchema =
  EscalationResolveFieldsSchema.superRefine(checkEscalationResolve);
export type EscalationResolve = z.infer<typeof EscalationResolveSchema>;
export type EscalationResolveInput = z.input<typeof EscalationResolveSchema>;

/** How an escalation was resolved. */
export const EscalationResolutionSchema = z.object({
  ...resolutionFields,
  resolvedAt: IsoDateTimeSchema,
});
export type EscalationResolution = z.infer<typeof EscalationResolutionSchema>;

export const EscalationSchema = z.object({
  id: PlanIdSchema,
  kind: EscalationKindSchema,
  level: EscalationLevelSchema,
  taskId: PlanIdSchema.nullable(),
  /**
   * The tasks the escalation pauses: its task and every task that depends
   * on it. Empty for an escalation without a task, which pauses the build.
   */
  tasks: z.array(PlanIdSchema).default([]),
  /** The review run that the escalation is about, when one is. */
  runId: RunIdSchema.optional(),
  /** One line that says what happened. */
  summary: z.string().min(1),
  /** The escalation file, relative to the build directory. */
  file: z.string().min(1),
  status: EscalationStatusSchema.default("open"),
  /** Why the escalation went to the owner after it was raised. */
  ownerReason: z.string().min(1).optional(),
  /** How the escalation was resolved, once it was. */
  resolution: EscalationResolutionSchema.optional(),
  /**
   * The engine defect note, relative to the build directory, when the
   * resolution named an engine defect as the cause.
   */
  defectNote: z.string().min(1).optional(),
  createdAt: IsoDateTimeSchema,
});
export type Escalation = z.infer<typeof EscalationSchema>;

/** Whether an escalation is open and what it pauses, or how it was resolved, in a few words. */
export function escalationState(e: Escalation): string {
  if (e.resolution) {
    return `resolved by the ${e.resolution.by.replace("_", " ")}: ${e.resolution.action}`;
  }
  return `open, pauses ${e.tasks.length > 0 ? e.tasks.join(", ") : "the build"}`;
}

/**
 * The engine defect note that holds a build paused for an engine defect:
 * the note of the latest escalation that names one. `undefined` for a
 * build that isn't paused for an engine defect.
 */
export function engineDefectNote(state: {
  pausedBy?: BuildPausedBy;
  escalations: readonly Pick<Escalation, "defectNote">[];
}): string | undefined {
  if (state.pausedBy !== "engine_defect") return undefined;
  return [...state.escalations].reverse().find((e) => e.defectNote)?.defectNote;
}

/** A build's saved state, in `.aio/builds/SLUG/state.json`. */
export const BuildStateSchema = z.object({
  /** The state file's format version. */
  version: z.literal(1),
  /** Names the build on leases and agent events. */
  id: BuildIdSchema,
  slug: BuildSlugSchema,
  projectId: z.string().min(1),
  /** The box whose session plans and watches the build, or `null`. */
  boxId: z.string().min(1).nullable(),
  /** The project container whose engine runs the build. */
  container: z.string().min(1),
  title: z.string(),
  /** The project's repository, which the build never changes. */
  repoPath: z.string().min(1),
  /** The commit the build branch started from. */
  base: CommitShaSchema,
  branch: z.string().min(1),
  /** The build worktree, where every agent and the task gate work. */
  worktree: z.string().min(1),
  status: BuildStatusSchema,
  step: BuildStepSchema,
  tasks: z.array(BuildTaskProgressSchema),
  /** The Contracts step's progress, once the step started. */
  contracts: BuildContractsProgressSchema.optional(),
  escalations: z.array(EscalationSchema),
  /** The order the tasks run in, which a resolution set. Absent means plan order. */
  taskOrder: z.array(PlanIdSchema).optional(),
  /** The placement levels above the role defaults; see `SeatPlacements` in the engine. */
  placements: BuildPlacementsSchema,
  /** The end of a timed pause, such as a vendor's limit reset. */
  pausedUntil: IsoDateTimeSchema.optional(),
  /** Who paused the build, while it is paused by a request, a box stop, or an engine defect. */
  pausedBy: BuildPausedBySchema.optional(),
  /**
   * `true` while the build is paused and the pause holds: no agent call or
   * gate runs, so the worktree stays as it is until a resume. Absent while
   * the build runs, and while a paused build finishes its current agent
   * call or gate.
   */
  idle: z.literal(true).optional(),
  /** The closing record of a cancelled build, relative to the build directory. */
  closingRecord: z.string().min(1).optional(),
  /**
   * When the owner deleted the build: its branch and worktree are gone, and
   * its directory keeps the record. A deleted build never resumes.
   */
  deletedAt: IsoDateTimeSchema.optional(),
  /** Why the build waits or failed, in one or two sentences. */
  note: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type BuildState = z.infer<typeof BuildStateSchema>;
