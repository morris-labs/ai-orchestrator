// Build pipeline execution: the build plan the engine carries out, the build
// request, and the build's saved state. See `docs/build-pipeline/design.md`.
//
// The plan covers what the walking skeleton uses: criteria, one task with
// its tests, and the test, type check, and lint commands. Later milestones
// widen it (several tasks, milestones, specialties, placements).
import { z } from "zod";
import { CommitShaSchema, IsoDateTimeSchema, VendorSchema } from "./common.js";
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

function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(ids.filter((id) => seen.size === seen.add(id).size))];
}

export const BuildPlanSchema = z
  .object({
    /** The plan's version; a revised plan gets the next one. */
    version: z.number().int().positive().default(1),
    title: z.string().min(1),
    criteria: z.array(BuildCriterionSchema).min(1),
    tasks: z.array(BuildTaskSchema).min(1).max(1, "a build plan has one task in this version"),
    commands: BuildCommandsSchema,
    /** Places every seat on this vendor. `null` leaves each seat on its own placement. */
    singleVendor: VendorSchema.nullable().default(null),
    /** Placement overrides by seat, over the role defaults and the single-vendor setting. */
    placements: z.record(RoleNameSchema, PlacementOverrideSchema).default({}),
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
  });
export type BuildPlan = z.infer<typeof BuildPlanSchema>;
export type BuildPlanInput = z.input<typeof BuildPlanSchema>;

/** A request to start a build. */
export const BuildCreateSchema = z
  .object({
    /** The project the build belongs to, as the server knows it. */
    projectId: z.string().min(1),
    /** The box whose session plans and watches the build, when one does. */
    boxId: z.string().min(1).optional(),
    slug: BuildSlugSchema,
    plan: BuildPlanSchema,
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
