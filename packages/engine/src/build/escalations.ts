// Escalations: decisions that execution can't make inside the build plan's
// bounds. Each one is a file in the build's `escalations/` directory, and the
// build waits for it. Resolving an escalation, and pausing only the affected
// task and its dependents, come with a later milestone.
import type { EscalationKind, EscalationLevel } from "@aio/contracts";
import { AgentFailed, DecisionNeeded, RoleDenied, describeError } from "../calls/index.js";
import { PlacementError } from "./placements/index.js";
import { SpecialtyError, UnknownSpecialtyError } from "./specialties/index.js";

/** What a step knows about an escalation before the engine files it. */
export interface EscalationDraft {
  kind: EscalationKind;
  level: EscalationLevel;
  taskId: string | null;
  /** One line that says what happened. */
  summary: string;
  /** Everything the resolver needs, such as the last gate output. */
  details: string;
}

/**
 * The escalation for an error from an agent call, or `null` when the error
 * isn't one that a person resolves. A limit with no reset time, a refused
 * lease, a call that failed twice, a vendor's refusal, a placement that
 * breaks a rule, and a specialty that can't be loaded all wait for the
 * Project manager.
 */
export function escalationForCallError(
  error: unknown,
  taskId: string | null,
): EscalationDraft | null {
  const message = describeError(error);
  if (error instanceof UnknownSpecialtyError || error instanceof SpecialtyError) {
    return {
      kind: "specialty",
      level: "project_manager",
      taskId,
      summary: `A specialty can't be loaded: ${error.message}`,
      details: message,
    };
  }
  if (error instanceof PlacementError) {
    return {
      kind: "placement",
      level: "project_manager",
      taskId,
      summary: `A seat can't be placed: ${error.message}`,
      details: message,
    };
  }
  if (
    error instanceof DecisionNeeded ||
    error instanceof RoleDenied ||
    error instanceof AgentFailed
  ) {
    return {
      kind: "agent_call",
      level: "project_manager",
      taskId,
      summary: `An agent call stopped: ${error.message}`,
      details: message,
    };
  }
  return null;
}
