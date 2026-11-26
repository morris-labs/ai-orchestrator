// The turn of an agent for an owner post: it acts on the post, and reports
// the acceptance criteria of the build plan that the post contradicts, which
// the engine flags to the Project manager as a change to the plan.
import { OwnerPostTurnAnswerSchema, type BuildCriterion } from "@aio/contracts";
import type { TurnAnswer } from "../sessions/prompts.js";

const OWNER_POST_ANSWER_JSON = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "contradicts"],
  properties: {
    summary: {
      type: "string",
      description: "What you did about the owner's post, in one or two sentences.",
    },
    contradicts: {
      type: "array",
      description:
        "The acceptance criteria that the post contradicts, each with the reason. Empty when it contradicts none.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["criterion", "reason"],
        properties: {
          criterion: { type: "string", description: "The criterion's ID, such as AC1." },
          reason: { type: "string", description: "How the post contradicts it, in one sentence." },
        },
      },
    },
  },
} as const;

/** The answer and guidance of a turn for an owner post, given the build plan's criteria. */
export function ownerPostAnswer(criteria: readonly BuildCriterion[]): TurnAnswer {
  return {
    output: { schema: OwnerPostTurnAnswerSchema, json: OWNER_POST_ANSWER_JSON },
    guidance: [
      "This message is a post from the owner. The engine records it as a decision on the task: work from it, and don't undo it later.",
      "Compare the post with the build plan's acceptance criteria. When the post contradicts one, list it in `contradicts` with the reason; the engine flags the post to the Project manager as a change to the plan. Leave `contradicts` empty when the post contradicts none.",
      "The build plan's acceptance criteria:",
      ...criteria.map((c) => `- ${c.id}: ${c.text}`),
    ].join("\n"),
  };
}
