// The session registry of a build: every agent session, with its seat and
// task, so a message for an agent whose turn ended resumes that session (the
// design's "Session resume"). The engine keeps it in the build's
// `sessions.json` file, so it survives an engine restart.
import { z } from "zod";
import { BuildStepSchema } from "./build-events.js";
import { RoleNameSchema } from "./build-roles.js";
import { PlanIdSchema } from "./builds.js";
import { IsoDateTimeSchema, VendorSchema } from "./common.js";
import { MessageIdSchema } from "./messages.js";
import { SeatPlacementSchema } from "./placements.js";
import { SpecialtyNameSchema } from "./specialties.js";

/** A session's ID in its build's registry: `S1`, `S2`, and so on, in start order. */
export const SessionIdSchema = z.string().regex(/^S[1-9][0-9]*$/);
export type SessionId = z.infer<typeof SessionIdSchema>;

/**
 * Why an agent started a session:
 *
 * - `step`: a build step called the seat for a new agent.
 * - `size`: a message came for a session larger than the threshold whose
 *   vendor's prompt cache expired.
 * - `placement`: a message came for a session whose seat's placement changed.
 * - `no_session`: a message came for an agent whose vendor reported no
 *   session to resume.
 */
export const SessionReasonSchema = z.enum(["step", "size", "placement", "no_session"]);
export type SessionReason = z.infer<typeof SessionReasonSchema>;

/** One finished turn of a session. */
export const SessionTurnSchema = z
  .object({
    /** The agent call's cache key. */
    key: z.string().min(1),
    /** The message the turn answered; `null` for a step's call. */
    messageId: MessageIdSchema.nullable(),
    /** When the turn ended. */
    at: IsoDateTimeSchema,
    /** The build worktree's `HEAD` when the turn ended. */
    head: z.string().min(1),
    /** The turn's input tokens, the registry's measure of the session's size. */
    inputTokens: z.number().int().nonnegative(),
  })
  .strict();
export type SessionTurn = z.infer<typeof SessionTurnSchema>;

/**
 * The task as the session's agent got it, so a fresh agent that takes over
 * gets the same brief: the role prompt's task fields without the context of
 * one attempt.
 */
export const SessionBriefSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    description: z.string(),
    ownedFiles: z.array(z.string()),
    contracts: z.array(z.string()).default([]),
    criteria: z.array(z.object({ id: z.string(), text: z.string() }).strict()),
    tests: z.array(z.string()).default([]),
    specialties: z.array(SpecialtyNameSchema).default([]),
  })
  .strict();
export type SessionBrief = z.infer<typeof SessionBriefSchema>;

/** One agent session: the seat and tasks it works for, and its turns. */
export const SessionRecordSchema = z
  .object({
    id: SessionIdSchema,
    seat: RoleNameSchema,
    /**
     * The plan tasks the session works for: one for a Developer, every task
     * in scope for the Test engineer's tests first, none for a seat that
     * works on no one task.
     */
    taskIds: z.array(PlanIdSchema),
    brief: SessionBriefSchema,
    /** The step the session started in. */
    step: BuildStepSchema,
    vendor: VendorSchema,
    model: z.string().min(1),
    /** The vendor's session ID, or `null` when the vendor reported none. */
    sessionId: z.string().min(1).nullable(),
    /**
     * The account folder that holds the vendor session, so a resume after an
     * engine restart runs there; `null` for the CLI's home folder. Absent for
     * a session recorded before the engine saved it.
     */
    accountFolder: z.string().min(1).nullable().optional(),
    /** The placement the session runs on. A different one for its seat starts a fresh agent. */
    placement: SeatPlacementSchema,
    /**
     * The vendor a rule keeps the seat's agents off, such as the Test
     * engineer's vendor for the coverage check. A message turn places the
     * seat with it too.
     */
    otherThan: VendorSchema.optional(),
    reason: SessionReasonSchema,
    /** The session this one took over from. */
    replaces: SessionIdSchema.nullable().default(null),
    /** The session that took over from this one; a replaced session gets no more messages. */
    replacedBy: SessionIdSchema.nullable().default(null),
    startedAt: IsoDateTimeSchema,
    turns: z.array(SessionTurnSchema).min(1),
  })
  .strict();
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

/** A message waiting for its addressee's session to take a turn. */
export const QueuedMessageSchema = z
  .object({
    messageId: MessageIdSchema,
    seat: RoleNameSchema,
    taskId: PlanIdSchema.nullable(),
  })
  .strict();
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

/** What became of a queued message. */
export const SessionDeliverySchema = z
  .object({
    messageId: MessageIdSchema,
    /** The session that took the message's turn. */
    session: SessionIdSchema.nullable(),
    status: z.enum(["delivered", "failed"]),
    at: IsoDateTimeSchema,
    /** Why a delivery failed. */
    note: z.string().min(1).optional(),
  })
  .strict();
export type SessionDelivery = z.infer<typeof SessionDeliverySchema>;

/** The build's `sessions.json` file. */
export const SessionRegistrySchema = z
  .object({
    version: z.literal(1).default(1),
    /** Every session in start order, replaced ones included. */
    sessions: z.array(SessionRecordSchema).default([]),
    /** Messages waiting for a turn, oldest first. */
    queue: z.array(QueuedMessageSchema).default([]),
    /** Every message that took a turn or failed to, oldest first. */
    deliveries: z.array(SessionDeliverySchema).default([]),
  })
  .strict();
export type SessionRegistry = z.infer<typeof SessionRegistrySchema>;
export type SessionRegistryInput = z.input<typeof SessionRegistrySchema>;
