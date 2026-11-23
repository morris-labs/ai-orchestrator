// The team chat: the messages that a build's agents and the owner exchange.
// Every message is a file in the build's `messages/` directory, and the team
// chat is a view of those files. Agents send through the `send_message` tool
// of the team chat MCP server, which the engine attaches to one agent call
// with a token for that agent, so the engine, not the agent, decides who the
// sender is. See ADR 0004 and `docs/build-pipeline/design.md` ("Team chat").
import { z } from "zod";
import { BuildIdSchema, SeatSchema } from "./build-events.js";
import { PlanIdSchema } from "./builds.js";
import { IsoDateTimeSchema } from "./common.js";

/** The seats that routing by type names. Role definitions use the same names. */
export const TEAM_SEATS = {
  projectManager: "project-manager",
  developer: "developer",
  testEngineer: "test-engineer",
  architect: "architect",
} as const;

/** The addressee name that stands for the owner. No role may take it as its name. */
export const OWNER_ADDRESS = "owner";

/** The most characters a message body can hold. */
export const MESSAGE_BODY_MAX = 20_000;

/**
 * What a message is. A message without an addressee goes where its type
 * says: a test dispute to the Test engineer, a file request to the
 * Developer of the task that owns the file, a contract question to the
 * Architect, and any other type to the Project manager.
 */
export const MessageTypeSchema = z.enum([
  "question",
  "answer",
  "test_dispute",
  "file_request",
  "contract_question",
  "bug_report",
  "handoff",
  "meeting_reply",
  "note",
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

/** A message ID in its build: `M1`, `M2`, and so on, in the order the engine saved them. */
export const MessageIdSchema = z.string().regex(/^M[1-9][0-9]*$/);
export type MessageId = z.infer<typeof MessageIdSchema>;

/** A milestone name in the build plan. */
export const MilestoneNameSchema = z.string().min(1).max(64);

/**
 * A sender or an addressee: an agent's seat, with the task it works on, or
 * the owner. `taskId` is `null` for a seat that works on no one task, such
 * as the Project manager.
 */
export const MessagePartySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("seat"),
      seat: SeatSchema,
      taskId: PlanIdSchema.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("owner") }).strict(),
]);
export type MessageParty = z.infer<typeof MessagePartySchema>;
export type SeatParty = Extract<MessageParty, { kind: "seat" }>;

/** How the engine chose the addressee: the sender named it, or the engine routed by type. */
export const MessageRoutingSchema = z.enum(["addressed", "by_type"]);
export type MessageRouting = z.infer<typeof MessageRoutingSchema>;

const MessageBodySchema = z
  .string()
  .min(1, { message: "the body can't be empty" })
  .max(MESSAGE_BODY_MAX, { message: `the body can hold at most ${MESSAGE_BODY_MAX} characters` });

/** One message, as the engine saves it in `messages/ID.json`. */
export interface Message {
  version: 1;
  id: MessageId;
  buildId: string;
  /** The sender. For an agent, the engine sets it from the agent's token. */
  from: MessageParty;
  to: MessageParty;
  routing: MessageRouting;
  type: MessageType;
  /** The task the message is about. */
  taskId: string | null;
  /** The milestone the message is about. */
  milestone: string | null;
  /** Repository-relative files the message is about, such as the files a file request needs. */
  paths: string[];
  body: string;
  createdAt: string;
}

// The annotation keeps the schema's type small: the event union and the
// route tables that embed it stay within what the compiler can serialize.
export const MessageSchema: z.ZodType<Message, z.ZodTypeDef, unknown> = z
  .object({
    version: z.literal(1),
    id: MessageIdSchema,
    buildId: BuildIdSchema,
    /** The sender. For an agent, the engine sets it from the agent's token. */
    from: MessagePartySchema,
    to: MessagePartySchema,
    routing: MessageRoutingSchema,
    type: MessageTypeSchema,
    /** The task the message is about. */
    taskId: PlanIdSchema.nullable(),
    /** The milestone the message is about. */
    milestone: MilestoneNameSchema.nullable(),
    /** Repository-relative files the message is about, such as the files a file request needs. */
    paths: z.array(z.string().min(1)).default([]),
    body: MessageBodySchema,
    createdAt: IsoDateTimeSchema,
  })
  .refine((m) => m.taskId !== null || m.milestone !== null, {
    message: "a message names a task or a milestone",
    path: ["taskId"],
  });

/**
 * The arguments of the `send_message` tool. The sender isn't among them:
 * the engine knows it from the agent's token, and a sender field fails the
 * call. Without `to`, the engine routes the message by its type.
 */
export const SendMessageInputSchema = z
  .object({
    type: MessageTypeSchema,
    body: MessageBodySchema,
    /** A seat, such as `architect`, or `owner`. Absent routes the message by its type. */
    to: SeatSchema.optional(),
    /** With `to`: the task of the addressee, when several agents fill that seat. */
    toTask: PlanIdSchema.optional(),
    /** The task the message is about. Default: the sender's task, then the addressee's. */
    taskId: PlanIdSchema.optional(),
    milestone: MilestoneNameSchema.optional(),
    paths: z.array(z.string().min(1)).max(50).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.type === "file_request" && (input.paths ?? []).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paths"],
        message: "a file request names the files it needs in paths",
      });
    }
  });
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

/** The payload of `message.sent`: the message as the engine saved it. */
export const messageSentFields = {
  message: MessageSchema,
};
