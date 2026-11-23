// Build pipeline execution: the build plan the engine carries out, the build
// request, and the build's saved state. See `docs/build-pipeline/design.md`.
//
// The full build plan holds what planning produced: the Analyst's spec (the
// stories, edge cases, criteria with their verification methods, size, usage
// estimate, secrets, and services), the Architect's design (the
// architecture, shared files, milestones, and task graph with specialties),
// the test, type check, and lint commands, the issue the plan starts from,
// and the owner's push answer. Execution reads the criteria, the tasks, and
// the commands; this version runs one task.
import { z } from "zod";
import {
  CommitShaSchema,
  CountSchema,
  EnvVarNameSchema,
  IsoDateTimeSchema,
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
import { BuildPlacementsSchema, PlacementOverrideSchema } from "./placements.js";
import { PolicyCommandSchema } from "./policy.js";
import { TaskSpecialtiesSchema } from "./specialties.js";

/** An ID in the build plan, such as `AC2` or `T1`. */
const PlanIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/, {
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
  })
  .strict();
export type BuildTask = z.infer<typeof BuildTaskSchema>;

/** The commands the task gate runs, which the Project manager seeds from the policy file. */
export const BuildCommandsSchema = z
  .object({
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

/** How big a build is; the size sets the seats. See the design's "Build size". */
export const BuildSizeSchema = z.enum(["small", "medium", "large"]);
export type BuildSize = z.infer<typeof BuildSizeSchema>;

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
})
  .strict()
  .superRefine((spec, ctx) => {
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
    checkMilestones(design.milestones, design.tasks, ctx);
  });
export type BuildDesign = z.infer<typeof BuildDesignSchema>;

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(ids.filter((id) => seen.size === seen.add(id).size))];
}

export const BuildPlanSchema = z
  .object({
    /** The plan's version; a revised plan gets the next one. */
    version: z.number().int().positive().default(1),
    title: z.string().min(1),
    /** The GitHub issue the plan starts from, or `null` for a request in the owner's words. */
    issue: BuildIssueSchema.nullable().default(null),
    /** The Analyst's stories and edge cases. */
    spec: BuildSpecTextSchema.nullable().default(null),
    size: BuildSizeSchema.nullable().default(null),
    usageEstimate: UsageEstimateSchema.nullable().default(null),
    /** The secrets the build needs, which the owner ticks for the project before approval. */
    secrets: z.array(BuildSecretSchema).default([]),
    services: z.array(BuildServiceSchema).default([]),
    criteria: z.array(BuildCriterionSchema).min(1),
    /** The Architect's architecture, in Markdown. */
    architecture: z.string().min(1).nullable().default(null),
    sharedFiles: z.array(RepoPathSchema).default([]),
    milestones: z.array(BuildMilestoneSchema).default([]),
    tasks: z.array(BuildTaskSchema).min(1).max(1, "a build plan has one task in this version"),
    commands: BuildCommandsSchema,
    /** Places every seat on this vendor. `null` leaves each seat on its own placement. */
    singleVendor: VendorSchema.nullable().default(null),
    /** Placement overrides by seat, over the role defaults and the single-vendor setting. */
    placements: z.record(RoleNameSchema, PlacementOverrideSchema).default({}),
    /**
     * The owner's answer to whether the build can push its build branch and
     * open its pull request: `true` or `false`, or `null` when nobody asked.
     * A freeze needs it.
     */
    push: z.boolean().nullable().default(null),
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
  return {
    title: spec.title,
    issue: extras.issue ?? null,
    spec: { summary: spec.summary, stories: spec.stories, edgeCases: spec.edgeCases },
    size: spec.size,
    usageEstimate: spec.usageEstimate,
    secrets: spec.secrets,
    services: spec.services,
    criteria: spec.criteria,
    architecture: design.architecture,
    sharedFiles: design.sharedFiles,
    milestones: design.milestones,
    tasks: design.tasks,
    commands: extras.commands,
    push: extras.push ?? null,
  };
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
});
export type BuildTaskProgress = z.infer<typeof BuildTaskProgressSchema>;

/** What raised an escalation. */
export const EscalationKindSchema = z.enum([
  /** A task failed the task gate on every attempt it has. */
  "attempt_cap",
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
  /** Tests first can't lock the tests, such as tests that fail the red check in every round. */
  "tests_first",
]);
export type EscalationKind = z.infer<typeof EscalationKindSchema>;

/** Who resolves an escalation. */
export const EscalationLevelSchema = z.enum(["project_manager", "owner"]);
export type EscalationLevel = z.infer<typeof EscalationLevelSchema>;

export const EscalationSchema = z.object({
  id: PlanIdSchema,
  kind: EscalationKindSchema,
  level: EscalationLevelSchema,
  taskId: PlanIdSchema.nullable(),
  /** One line that says what happened. */
  summary: z.string().min(1),
  /** The escalation file, relative to the build directory. */
  file: z.string().min(1),
  createdAt: IsoDateTimeSchema,
});
export type Escalation = z.infer<typeof EscalationSchema>;

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
  escalations: z.array(EscalationSchema),
  /** The placement levels above the role defaults; see `SeatPlacements` in the engine. */
  placements: BuildPlacementsSchema,
  /** The end of a timed pause, such as a vendor's limit reset. */
  pausedUntil: IsoDateTimeSchema.optional(),
  /** Why the build waits or failed, in one or two sentences. */
  note: z.string().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type BuildState = z.infer<typeof BuildStateSchema>;
