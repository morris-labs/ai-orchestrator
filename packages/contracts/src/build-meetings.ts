// Planning meetings: the Project manager opens a meeting for one proposal,
// such as the Architect's design, and code takes the turns. The proposer
// posts, each invited role replies once per round with a position and a
// severity for each point, and the proposer revises. The meeting ends when
// no major objection remains or at its round cap. See
// `docs/build-pipeline/design.md`, "Meetings".
import { z } from "zod";
import { RoleNameSchema } from "./build-roles.js";
import {
  BuildPlanningSchema,
  MeetingIdSchema,
  MeetingStatusSchema,
  PlanningScope,
} from "./build-planning.js";
import { IsoDateTimeSchema } from "./common.js";

/** The rounds a meeting runs at most, unless its request says otherwise. */
export const MEETING_ROUND_CAP = 3;

/** The most rounds a meeting request can ask for. */
export const MEETING_ROUND_MAX = 10;

/** The words a reply should stay under, unless the member's role says otherwise. */
export const MEETING_REPLY_WORDS = 200;

/** A member's stand on the proposal. */
export const MeetingPositionSchema = z.enum(["object", "concern", "no_objection"]);
export type MeetingPosition = z.infer<typeof MeetingPositionSchema>;

/** How much a point matters: a major point keeps the meeting going. */
export const MeetingSeveritySchema = z.enum(["major", "minor"]);
export type MeetingSeverity = z.infer<typeof MeetingSeveritySchema>;

/** One point of a reply, with its severity and its reason. */
export const MeetingPointSchema = z
  .object({
    severity: MeetingSeveritySchema,
    point: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();
export type MeetingPoint = z.infer<typeof MeetingPointSchema>;

/** A member's reply in one round. `no_objection` holds no major point. */
export const MeetingReplySchema = z
  .object({
    position: MeetingPositionSchema,
    /** The reply in a sentence or two. */
    summary: z.string().min(1),
    points: z.array(MeetingPointSchema),
  })
  .strict()
  .superRefine((reply, ctx) => {
    if (reply.position === "no_objection" && reply.points.some((p) => p.severity === "major")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["position"],
        message: "a reply with a major point is an objection or a concern, not no_objection",
      });
    }
    if (reply.position === "object" && reply.points.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["points"],
        message: "an objection names its points",
      });
    }
  });
export type MeetingReply = z.infer<typeof MeetingReplySchema>;

/** The reply's JSON schema, which a member's prompt and its vendor's structured output use. */
export const MEETING_REPLY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["position", "summary", "points"],
  properties: {
    position: {
      type: "string",
      enum: MeetingPositionSchema.options,
      description:
        "object when a point must change before the build starts, concern when you doubt part of it, no_objection otherwise.",
    },
    summary: { type: "string", description: "Your reply in one or two sentences." },
    points: {
      type: "array",
      description: "Each point you raise, with its severity. Empty for no objection.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "point", "reason"],
        properties: {
          severity: {
            type: "string",
            enum: MeetingSeveritySchema.options,
            description: "major when the proposal must change; minor otherwise.",
          },
          point: { type: "string", description: "What is wrong or missing." },
          reason: { type: "string", description: "Why, with the evidence." },
        },
      },
    },
  },
} as const;

/** A major point that a member still holds, with the member's seat. */
export const MeetingObjectionSchema = MeetingPointSchema.extend({ seat: RoleNameSchema });
export type MeetingObjection = z.infer<typeof MeetingObjectionSchema>;

/** The major points of a round's replies, in reply order. */
export function majorObjections(
  replies: readonly { seat: string; reply: MeetingReply | null }[],
): MeetingObjection[] {
  return replies.flatMap(({ seat, reply }) =>
    (reply?.points ?? [])
      .filter((p) => p.severity === "major")
      .map((p) => ({ seat, severity: p.severity, point: p.point, reason: p.reason })),
  );
}

/** One member's turn in a round. */
export const MeetingTurnSchema = z.object({
  seat: RoleNameSchema,
  status: z.enum(["running", "done", "failed"]),
  /** The planning call files of the turn: the first reply and, when it broke the structure, the retry. */
  files: z.array(z.string().min(1)),
  /** The reply, once one keeps the structure. */
  reply: MeetingReplySchema.nullable(),
  /** The owner posts the turn's prompt carried, by index in `posts`. */
  posts: z.array(z.number().int().nonnegative()),
});
export type MeetingTurn = z.infer<typeof MeetingTurnSchema>;

/** One round: the proposal under discussion and each member's reply. */
export const MeetingRoundSchema = z.object({
  n: z.number().int().positive(),
  /** The planning call file that holds the proposal. */
  proposal: z.string().min(1),
  turns: z.array(MeetingTurnSchema),
});
export type MeetingRound = z.infer<typeof MeetingRoundSchema>;

/** An owner post in a meeting. Every member reads it at its next turn. */
export const MeetingPostSchema = z.object({
  body: z.string().min(1),
  postedAt: IsoDateTimeSchema,
});
export type MeetingPost = z.infer<typeof MeetingPostSchema>;

/** A meeting's record, in `.aio/builds/SLUG/meetings/ID.json`. */
export const BuildMeetingSchema = z.object({
  version: z.literal(1),
  id: MeetingIdSchema,
  /** The seat that proposes and revises. */
  proposer: RoleNameSchema,
  /** The seats that reply once per round. */
  members: z.array(RoleNameSchema).min(1),
  /** What the Project manager asks the meeting to settle. */
  brief: z.string().min(1),
  roundCap: z.number().int().positive(),
  status: MeetingStatusSchema,
  rounds: z.array(MeetingRoundSchema),
  posts: z.array(MeetingPostSchema),
  /** The major objections left when the meeting ended. */
  open: z.array(MeetingObjectionSchema),
  /** Why the meeting failed, in one line. */
  error: z.string().optional(),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.optional(),
});
export type BuildMeeting = z.infer<typeof BuildMeetingSchema>;

/** A request to open a meeting. The answer waits until the meeting ends. */
export const BuildMeetingRequestSchema = z
  .object({
    ...PlanningScope,
    /** The seat whose proposal the meeting discusses. Its latest answer is the first proposal. */
    proposer: RoleNameSchema.default("architect"),
    /** The seats that reply. The Critic runs on a vendor other than the proposer's. */
    members: z.array(RoleNameSchema).min(1).max(8).default(["critic"]),
    /** What the Project manager asks the meeting to settle. */
    brief: z.string().min(1),
    /** The round cap. */
    rounds: z.number().int().min(1).max(MEETING_ROUND_MAX).default(MEETING_ROUND_CAP),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.members.includes(request.proposer)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["members"],
        message: "the proposer isn't one of the members",
      });
    }
    if (new Set(request.members).size !== request.members.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["members"],
        message: "name each member once",
      });
    }
  });
export type BuildMeetingRequest = z.infer<typeof BuildMeetingRequestSchema>;
export type BuildMeetingRequestInput = z.input<typeof BuildMeetingRequestSchema>;

/** The answer to a meeting request or a meeting post: the planning record and the meeting. */
export const BuildMeetingAnswerSchema = z.object({
  planning: BuildPlanningSchema,
  meeting: BuildMeetingSchema,
});
export type BuildMeetingAnswer = z.infer<typeof BuildMeetingAnswerSchema>;

/** An owner post to a running meeting, which the Project manager relays. */
export const BuildMeetingPostRequestSchema = z
  .object({
    ...PlanningScope,
    meeting: MeetingIdSchema,
    body: z.string().min(1).max(20_000),
  })
  .strict();
export type BuildMeetingPostRequest = z.infer<typeof BuildMeetingPostRequestSchema>;
