// Owner posts and direct messages. The owner posts to one agent of a build,
// and the engine records each post as a decision that it attaches to the
// post's task, so later agents on the task work from it. An agent can send
// the owner a direct message, within a limit per milestone. See the
// "Owner posts" and "Direct messages" sections of
// `docs/build-pipeline/design.md`.
import { z } from "zod";
import { BuildIdSchema, SeatSchema } from "./build-events.js";
import { BuildMeetingSchema, type BuildMeeting } from "./build-meetings.js";
import { PlanIdSchema } from "./builds.js";
import { IsoDateTimeSchema } from "./common.js";
import {
  MESSAGE_BODY_MAX,
  MessageIdSchema,
  MessagePartySchema,
  MessageSchema,
  MessageTypeSchema,
  MilestoneNameSchema,
  OWNER_ADDRESS,
  type Message,
  type MessageParty,
} from "./messages.js";

/** How many direct messages each agent can send the owner in one milestone, unless the plan sets it. */
export const DIRECT_MESSAGE_LIMIT = 2;

/**
 * A post from the owner to one agent of a build. The addressee is a seat,
 * with `toTask` when several agents fill it. The post is about the
 * addressee's task unless it names `taskId` or `milestone`.
 */
export const OwnerPostSchema = z
  .object({
    to: SeatSchema.refine((seat) => seat !== OWNER_ADDRESS, {
      message: "an owner post goes to a seat, not to the owner",
    }),
    toTask: PlanIdSchema.optional(),
    taskId: PlanIdSchema.optional(),
    milestone: MilestoneNameSchema.optional(),
    type: MessageTypeSchema.default("note"),
    body: z.string().min(1).max(MESSAGE_BODY_MAX),
  })
  .strict();
export type OwnerPost = z.infer<typeof OwnerPostSchema>;
export type OwnerPostInput = z.input<typeof OwnerPostSchema>;

/** A decision ID in its build: `D1`, `D2`, and so on, in the order the engine recorded them. */
export const DecisionIdSchema = z.string().regex(/^D[1-9][0-9]*$/);

/**
 * An agent's report that an owner post contradicts acceptance criteria of
 * the build plan. The engine flags it to the Project manager as a change to
 * the plan.
 */
export const PlanChangeFlagSchema = z
  .object({
    /** The IDs of the criteria that the post contradicts. */
    criteria: z.array(z.string().min(1)).min(1),
    reason: z.string().min(1),
    /** The agent that reported the contradiction. */
    reportedBy: MessagePartySchema,
    /** The team chat message that flags the post to the Project manager, if one was sent. */
    messageId: MessageIdSchema.nullable(),
    flaggedAt: IsoDateTimeSchema,
  })
  .strict();
export type PlanChangeFlag = z.infer<typeof PlanChangeFlagSchema>;

/** One decision, as the engine saves it in `decisions/ID.json`. */
export interface BuildDecision {
  version: 1;
  id: string;
  buildId: string;
  /** The owner post that the decision records. */
  messageId: string;
  /** The agent the owner posted to. */
  to: MessageParty;
  /** The task the decision is attached to. */
  taskId: string | null;
  /** The milestone the decision is attached to. */
  milestone: string | null;
  body: string;
  createdAt: string;
  /** The plan change flag, once an agent reports that the post contradicts the plan. */
  planChange: PlanChangeFlag | null;
}

// The annotation keeps the type small for the route tables that embed it.
export const BuildDecisionSchema: z.ZodType<BuildDecision, z.ZodTypeDef, unknown> = z
  .object({
    version: z.literal(1),
    id: DecisionIdSchema,
    buildId: BuildIdSchema,
    messageId: MessageIdSchema,
    to: MessagePartySchema,
    taskId: PlanIdSchema.nullable(),
    milestone: MilestoneNameSchema.nullable(),
    body: z.string().min(1),
    createdAt: IsoDateTimeSchema,
    planChange: PlanChangeFlagSchema.nullable(),
  })
  .strict();

/**
 * The answer to an owner post. A post for a seat of a planning meeting under
 * way goes into the meeting, which brings it to every member at its next
 * turn (`route: "meeting"`). Any other post goes to its agent on the team
 * chat, and the engine records it as a decision (`route: "agent"`).
 */
export type OwnerPostAnswer =
  | { route: "agent"; message: Message; decision: BuildDecision }
  | { route: "meeting"; meeting: BuildMeeting };
export const OwnerPostAnswerSchema: z.ZodType<OwnerPostAnswer, z.ZodTypeDef, unknown> =
  z.discriminatedUnion("route", [
    z.object({
      route: z.literal("agent"),
      message: MessageSchema,
      decision: BuildDecisionSchema,
    }),
    z.object({ route: z.literal("meeting"), meeting: BuildMeetingSchema }),
  ]);

/** A build's decisions, oldest first. */
export const BuildDecisionListSchema = z.object({ decisions: z.array(BuildDecisionSchema) });
export type BuildDecisionList = z.infer<typeof BuildDecisionListSchema>;

/**
 * The answer of an agent's turn for an owner post: what it did, and the
 * acceptance criteria the post contradicts, if any.
 */
export const OwnerPostTurnAnswerSchema = z
  .object({
    summary: z.string(),
    contradicts: z
      .array(z.object({ criterion: z.string().min(1), reason: z.string().min(1) }).passthrough())
      .default([]),
  })
  .passthrough();
export type OwnerPostTurnAnswer = z.infer<typeof OwnerPostTurnAnswerSchema>;
