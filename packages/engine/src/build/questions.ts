// The question cap: each agent, a seat on a task, can ask a set number of
// questions about one task. A question past the cap doesn't reach its
// addressee: it goes to the Project manager as an escalation, which pauses
// the task until the Project manager resolves it. See the design's "Team
// chat" section.
import { QUESTION_CAP, TEAM_SEATS, type BuildPlan, type Message } from "@aio/contracts";
import type { EscalationDraft } from "./escalations.js";

/** The questions each agent can ask about one task under `plan`. */
export function questionCap(plan: Pick<BuildPlan, "questionsPerTask">): number {
  return plan.questionsPerTask ?? QUESTION_CAP;
}

/** True for a question that an agent asked about a task; only these count against the cap. */
function countsAgainstCap(message: Message): boolean {
  return message.type === "question" && message.from.kind === "seat" && message.taskId !== null;
}

function sameAsker(a: Message, b: Message): boolean {
  return (
    a.from.kind === "seat" &&
    b.from.kind === "seat" &&
    a.from.seat === b.from.seat &&
    a.from.taskId === b.from.taskId &&
    a.taskId === b.taskId
  );
}

function describeParty(party: Message["to"]): string {
  if (party.kind === "owner") return "the owner";
  return party.taskId ? `${party.seat} (task ${party.taskId})` : party.seat;
}

/**
 * Checks `message` against its sender's question cap. Returns `undefined`
 * for a message within the cap, and otherwise raises an escalation with
 * `escalate` and returns the message routed to the Project manager.
 * `earlier` returns the build's saved messages.
 */
export async function capQuestion(
  message: Message,
  plan: Pick<BuildPlan, "questionsPerTask">,
  earlier: () => Promise<readonly Message[]>,
  escalate: (draft: EscalationDraft) => Promise<unknown>,
): Promise<Message | undefined> {
  if (!countsAgainstCap(message)) return undefined;
  const cap = questionCap(plan);
  const asked = (await earlier()).filter((m) => countsAgainstCap(m) && sameAsker(m, message));
  if (asked.length < cap) return undefined;
  const from = message.from.kind === "seat" ? message.from.seat : "owner";
  await escalate({
    kind: "question_cap",
    level: "project_manager",
    taskId: message.taskId,
    summary: `The ${from} asked question ${asked.length + 1} about task ${message.taskId}, past the cap of ${cap}.`,
    details: [
      `Question ${message.id}, from ${describeParty(message.from)} to ${describeParty(message.to)}, went to the Project manager instead.`,
      `The cap is ${cap} questions per task. Earlier questions: ${asked.map((m) => m.id).join(", ") || "none"}.`,
      "Answer it with a reply on the team chat, add a clarification, or retry the task.",
      "",
      message.body,
    ].join("\n"),
  });
  return {
    ...message,
    to: { kind: "seat", seat: TEAM_SEATS.projectManager, taskId: null },
    routing: "escalated",
  };
}
