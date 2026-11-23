// Where a team chat message goes. A sender can name a seat or the owner;
// without one, the engine routes the message by its type (see the design's
// "Team chat" section).
import {
  OWNER_ADDRESS,
  TEAM_SEATS,
  type Message,
  type MessageParty,
  type MessageRouting,
  type SendMessageInput,
} from "@aio/contracts";
import { globToRegExp } from "../policy/glob.js";

/** What routing needs to know about a task of the build plan. */
export interface RouteTask {
  id: string;
  /** The seat that works the task, such as `developer`. */
  role: string;
  /** Repository-relative paths or globs that the task owns. */
  ownedFiles: readonly string[];
}

export interface Route {
  to: MessageParty;
  routing: MessageRouting;
}

/** The task whose owned files cover `path`, or `null` when none does. */
export function taskOwning(tasks: readonly RouteTask[], path: string): RouteTask | null {
  const clean = path.replace(/^\.\//, "");
  return (
    tasks.find((task) => task.ownedFiles.some((glob) => globToRegExp(glob).test(clean))) ?? null
  );
}

const seat = (name: string, taskId: string | null): MessageParty => ({
  kind: "seat",
  seat: name,
  taskId,
});

/**
 * The addressee of a message that `sender` sends with `input`:
 *
 * - A named addressee (`to`, with `toTask`) as given, and `owner` as the owner.
 * - A reply: the sender of `replied`, the message it replies to.
 * - A test dispute: the Test engineer of the message's task.
 * - A file request: the seat that works the task owning the first of
 *   `paths` that a task owns, or the Project manager when no task owns one.
 * - A contract question: the Architect.
 * - Any other type: the Project manager.
 */
export function routeMessage(
  input: SendMessageInput,
  sender: MessageParty,
  tasks: readonly RouteTask[],
  replied?: Message,
): Route {
  const senderTask = sender.kind === "seat" ? sender.taskId : null;
  if (input.to !== undefined) {
    const to =
      input.to === OWNER_ADDRESS
        ? { kind: "owner" as const }
        : seat(input.to, input.toTask ?? null);
    return { to, routing: "addressed" };
  }
  if (replied) return { to: replied.from, routing: "reply" };
  const byType = (to: MessageParty): Route => ({ to, routing: "by_type" });
  switch (input.type) {
    case "test_dispute":
      return byType(seat(TEAM_SEATS.testEngineer, input.taskId ?? senderTask));
    case "file_request": {
      for (const path of input.paths ?? []) {
        const owner = taskOwning(tasks, path);
        if (owner) return byType(seat(owner.role, owner.id));
      }
      return byType(seat(TEAM_SEATS.projectManager, null));
    }
    case "contract_question":
      return byType(seat(TEAM_SEATS.architect, null));
    default:
      return byType(seat(TEAM_SEATS.projectManager, null));
  }
}
