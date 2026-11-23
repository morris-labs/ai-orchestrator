// Build planning: the record of a build before execution. The Project manager
// calls the planning seats (the Analyst and the Architect) as engine calls
// under leases, then freezes the build plan when the owner approves it. Each
// freeze that changes the plan writes the next version; a frozen version
// never changes. See `docs/build-pipeline/design.md`, "Planning".
import { z } from "zod";
import { BuildIdSchema, BuildSlugSchema } from "./build-events.js";
import { RoleNameSchema } from "./build-roles.js";
import { BuildIssueSchema, BuildPlanSchema } from "./builds.js";
import { IsoDateTimeSchema } from "./common.js";

/** Where a build's planning record lives, relative to the build directory. */
export const BUILD_PLANNING_FILE = "planning.json";

/** The plan draft the engine writes after each seat answer, relative to the build directory. */
export const BUILD_DRAFT_FILE = "planning/draft.json";

export const PlanningCallStatusSchema = z.enum(["running", "done", "failed"]);
export type PlanningCallStatus = z.infer<typeof PlanningCallStatusSchema>;

/** One planning seat call: its seat, its turn count, and the file that holds its brief and answer. */
export const PlanningCallSchema = z.object({
  /** The call's cache key, unique in the build. */
  key: z.string().min(1),
  seat: RoleNameSchema,
  /** The seat's call count: 1 for its first call, 2 for a revision, and so on. */
  n: z.number().int().positive(),
  status: PlanningCallStatusSchema,
  /** The call's file, relative to the build directory. */
  file: z.string().min(1),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.optional(),
  /** Why the call failed, in one line. */
  error: z.string().optional(),
});
export type PlanningCall = z.infer<typeof PlanningCallSchema>;

/** A frozen version of the build plan. */
export const FrozenPlanSchema = z.object({
  version: z.number().int().positive(),
  /** The version's file, relative to the build directory. The engine never changes it. */
  file: z.string().min(1),
  /** The SHA-256 of the plan without its version, in hex. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** The owner's push answer that the version records. */
  push: z.boolean(),
  frozenAt: IsoDateTimeSchema,
});
export type FrozenPlan = z.infer<typeof FrozenPlanSchema>;

/** A meeting's ID in its build: `meeting-1`, `meeting-2`, and so on. */
export const MeetingIdSchema = z.string().regex(/^meeting-[1-9][0-9]*$/);
export type MeetingId = z.infer<typeof MeetingIdSchema>;

/**
 * Where a meeting stands: `running`, `agreed` when no major objection
 * remains, `round_cap` when it stopped at its round cap with objections
 * open, or `failed`.
 */
export const MeetingStatusSchema = z.enum(["running", "agreed", "round_cap", "failed"]);
export type MeetingStatus = z.infer<typeof MeetingStatusSchema>;

/** A meeting in the planning record; its file holds the turns. */
export const PlanningMeetingSchema = z.object({
  id: MeetingIdSchema,
  /** The meeting's file, relative to the build directory. */
  file: z.string().min(1),
  status: MeetingStatusSchema,
});
export type PlanningMeeting = z.infer<typeof PlanningMeetingSchema>;

/** A build's planning record, in `.aio/builds/SLUG/planning.json`. */
export const BuildPlanningSchema = z.object({
  version: z.literal(1),
  /** The build's id, which its planning calls and, later, its execution name. */
  id: BuildIdSchema,
  slug: BuildSlugSchema,
  projectId: z.string().min(1),
  /** The box whose Project manager plans the build, or `null`. */
  boxId: z.string().min(1).nullable(),
  container: z.string().min(1),
  /** The repository the planning seats read. */
  repoPath: z.string().min(1),
  /** The GitHub issue the build starts from, or `null`. */
  issue: BuildIssueSchema.nullable(),
  calls: z.array(PlanningCallSchema),
  /** The frozen versions of the build plan, oldest first. */
  frozen: z.array(FrozenPlanSchema),
  /** The planning meetings, oldest first. */
  meetings: z.array(PlanningMeetingSchema).default([]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type BuildPlanning = z.infer<typeof BuildPlanningSchema>;

/** Who asks: every planning request names its project and, from a box session, its box. */
export const PlanningScope = {
  projectId: z.string().min(1),
  boxId: z.string().min(1).nullable(),
  slug: BuildSlugSchema,
};

/** A request to call a planning seat. The answer waits for the seat's turn to end. */
export const BuildSeatRequestSchema = z
  .object({
    ...PlanningScope,
    /** The seat to call, such as `analyst` or `architect`. Its role must be read-only. */
    seat: RoleNameSchema,
    /** What the Project manager asks of the seat: the owner's request, or the changes to make. */
    brief: z.string().min(1),
    /** The GitHub issue the build starts from. Only the build's first planning request can set it. */
    issue: BuildIssueSchema.optional(),
  })
  .strict();
export type BuildSeatRequest = z.infer<typeof BuildSeatRequestSchema>;
export type BuildSeatRequestInput = z.input<typeof BuildSeatRequestSchema>;

/** The answer to a seat call: the planning record, the call, and the seat's answer. */
export const BuildSeatAnswerSchema = z.object({
  planning: BuildPlanningSchema,
  call: PlanningCallSchema,
  answer: z.record(z.unknown()),
});
export type BuildSeatAnswer = z.infer<typeof BuildSeatAnswerSchema>;

/**
 * A request to freeze the build plan. Absent, `plan` means the draft in
 * `planning/draft.json`. `push` records the owner's push answer over the
 * plan's own.
 */
export const BuildFreezeRequestSchema = z
  .object({
    ...PlanningScope,
    plan: z.record(z.unknown()).optional(),
    push: z.boolean().optional(),
  })
  .strict();
export type BuildFreezeRequest = z.infer<typeof BuildFreezeRequestSchema>;

/** The answer to a freeze: the planning record, the frozen version, and its plan. */
export const BuildFreezeAnswerSchema = z.object({
  planning: BuildPlanningSchema,
  frozen: FrozenPlanSchema,
  plan: BuildPlanSchema,
});
export type BuildFreezeAnswer = z.infer<typeof BuildFreezeAnswerSchema>;

/**
 * The answer to a planning pause or resume request: whether the planning
 * seat calls and meetings now wait. A box stop pauses its build's planning,
 * and a box start resumes it.
 */
export const BuildPlanningControlAnswerSchema = z.object({ paused: z.boolean() });
export type BuildPlanningControlAnswer = z.infer<typeof BuildPlanningControlAnswerSchema>;
