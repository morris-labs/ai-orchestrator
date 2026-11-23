// Build pipeline parts of the event stream and the usage records.
//
// A build is one effort of the build pipeline. Its agent calls run under
// leases like a review run's calls, and they name the build, the seat they
// fill, and the step of the milestone loop they belong to, so usage counts by
// seat and by step. A call belongs to a review run (`runId`), to a build
// (`buildId`), or to both, for a review run that a build starts.
//
// The `events.ts` and `lease.ts` modules compose these parts into the event
// union and the lease frames.
import { z } from "zod";
import { RoleNameSchema } from "./build-roles.js";
import { CountSchema, IsoDateTimeSchema, RunIdSchema, UlidSchema } from "./common.js";

/** A build id. Engines mint build ids as ULIDs, so one is unique across every engine. */
export const BuildIdSchema = UlidSchema;
export type BuildId = z.infer<typeof BuildIdSchema>;

/** A build's short kebab-case name; its files live in `.aio/builds/SLUG/`. */
export const BuildSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export type BuildSlug = z.infer<typeof BuildSlugSchema>;

/**
 * A seat: the role a build activates, named by its role definition, such
 * as `developer` or `test-engineer`.
 */
export const SeatSchema = RoleNameSchema;
export type Seat = z.infer<typeof SeatSchema>;

/**
 * The part of a build a call or a state belongs to: `planning` before the
 * build plan is frozen, `preflight` for the baseline, the milestone loop
 * steps in order, and `release_ready` for the push and CI loop.
 */
export const BuildStepSchema = z.enum([
  "planning",
  "preflight",
  "contracts",
  "tests_first",
  "tasks",
  "integrate",
  "harden",
  "simplify",
  "review",
  "release_ready",
]);
export type BuildStep = z.infer<typeof BuildStepSchema>;

export const BuildStatusSchema = z.enum([
  "planning",
  "running",
  "paused",
  "waiting_escalation",
  "finished",
  "failed",
  "cancelled",
]);
export type BuildStatus = z.infer<typeof BuildStatusSchema>;

/** A build as the server mirrors it; the payload of `build.changed`. */
export const BuildSummarySchema = z.object({
  id: BuildIdSchema,
  slug: BuildSlugSchema,
  projectId: z.string().min(1),
  /** The project container whose engine runs the build. */
  container: z.string().min(1),
  status: BuildStatusSchema,
  /** The step the build is in; `null` before it starts one. */
  step: BuildStepSchema.nullable(),
  /**
   * The box whose Project manager runs the build, or `null` when no box
   * does. An event that leaves it out reads as `null`.
   */
  boxId: z.string().min(1).nullable().default(null),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type BuildSummary = z.infer<typeof BuildSummarySchema>;

/** The query of `builds.list`: every build on the machine, or one project's. */
export const BuildListQuerySchema = z.object({ projectId: z.string().min(1).optional() });

/** The response of `builds.list`: newest first. */
export const BuildListSchema = z.object({ builds: z.array(BuildSummarySchema) });
export type BuildList = z.infer<typeof BuildListSchema>;

export const BuildTaskStatusSchema = z.enum(["pending", "running", "done", "failed", "blocked"]);
export type BuildTaskStatus = z.infer<typeof BuildTaskStatusSchema>;

/** The payload of `build.changed`. */
export const buildChangedFields = {
  build: BuildSummarySchema,
};

/** The payload of `build.task.changed`. */
export const buildTaskChangedFields = {
  buildId: BuildIdSchema,
  /** The task's id in the build plan. */
  taskId: z.string().min(1),
  status: BuildTaskStatusSchema,
  previousStatus: BuildTaskStatusSchema.nullable(),
};

/**
 * Who a call under a lease belongs to, on lease requests, settlements, and
 * agent events. A review run's call has a `runId` and leaves the build
 * fields out. A build's call has `runId: null` and every build field. A call
 * of a review run that a build started has both. At least one of `runId` and
 * `buildId` is set; the server refuses an event with neither.
 */
export const callOwnerFields = {
  /** The review run, or `null` for a build call outside a review run. */
  runId: RunIdSchema.nullable(),
  /** The build, for a build call. Absent for a stand-alone review run. */
  buildId: BuildIdSchema.optional(),
  /** The seat the call fills, for a build call. */
  seat: SeatSchema.optional(),
  /** The step the call belongs to, for a build call. */
  step: BuildStepSchema.optional(),
};

/** Settled usage summed over a set of lease settlements. */
export const UsageTotalsSchema = z.object({
  /** How many settled calls. */
  calls: CountSchema,
  tokensIn: CountSchema,
  tokensOut: CountSchema,
  premiumRequests: z.number().nonnegative(),
  /** Estimated cost in US dollars. */
  costEstimate: z.number().nonnegative(),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

/** The response of `builds.usage`: one build's settled usage, in total, by seat, and by step. */
export const BuildUsageSchema = z.object({
  buildId: BuildIdSchema,
  total: UsageTotalsSchema,
  /** One row per seat, sorted by name; `null`, last, collects calls that named no seat. */
  bySeat: z.array(UsageTotalsSchema.extend({ seat: SeatSchema.nullable() })),
  /** One row per step, in `BuildStepSchema` order; `null`, last, collects calls that named no step. */
  byStep: z.array(UsageTotalsSchema.extend({ step: BuildStepSchema.nullable() })),
});
export type BuildUsage = z.infer<typeof BuildUsageSchema>;
