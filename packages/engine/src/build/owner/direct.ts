// The rate limit of direct messages: each agent, a seat on a task, can send
// the owner a set number of messages in each milestone. A message past the
// limit is refused with the reason, and the agent's work goes on.
import { DIRECT_MESSAGE_LIMIT, type BuildPlan, type Message } from "@aio/contracts";
import { MessageRefused } from "../../team/index.js";
import { milestoneOfTask } from "./decisions.js";

/** True for a message that an agent sent the owner. */
export function isDirectMessage(message: Message): boolean {
  return message.from.kind === "seat" && message.to.kind === "owner";
}

/** The milestone a message counts against: its own, then its task's, or `null` for none. */
function milestoneOf(plan: BuildPlan, message: Message): string | null {
  return message.milestone ?? milestoneOfTask(plan, message.taskId);
}

function sameSender(a: Message["from"], b: Message["from"]): boolean {
  return a.kind === "seat" && b.kind === "seat" && a.seat === b.seat && a.taskId === b.taskId;
}

/**
 * Refuses `message` with `MessageRefused` when it's a direct message past
 * its sender's limit in its milestone. `earlier` returns the build's saved
 * messages.
 */
export async function checkDirectMessage(
  message: Message,
  plan: BuildPlan,
  earlier: () => Promise<readonly Message[]>,
): Promise<void> {
  if (!isDirectMessage(message)) return;
  const limit = plan.directMessagesPerMilestone ?? DIRECT_MESSAGE_LIMIT;
  const milestone = milestoneOf(plan, message);
  const sent = (await earlier()).filter(
    (m) =>
      isDirectMessage(m) && sameSender(m.from, message.from) && milestoneOf(plan, m) === milestone,
  ).length;
  if (sent < limit) return;
  const where = milestone === null ? "in this build" : `in milestone ${milestone}`;
  throw new MessageRefused(
    `The limit is ${limit} direct messages to the owner per milestone, and you sent ${sent} ${where}. Send the concern to the Project manager instead (leave out "to"), and go on with your work.`,
  );
}
