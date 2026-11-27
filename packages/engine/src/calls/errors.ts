// Errors that the agent-call core throws. Every state machine that makes
// agent calls catches these: the review controller turns them into run
// decisions and reports, and a build turns them into escalations.
import type { AgentRole, Decision, Vendor } from "@aio/contracts";

/** Thrown inside a step to stop the work and wait for a person. */
export class DecisionNeeded extends Error {
  constructor(readonly decision: Decision) {
    super(decision.message);
    this.name = "DecisionNeeded";
  }
}

/** Thrown when the caller is cancelled, or its driver stopped. */
export class RunCancelled extends Error {
  /** The tokens a stopped call spent before it stopped, when its adapter could tell. */
  tokens: unknown = undefined;

  constructor() {
    super("The run was cancelled.");
    this.name = "RunCancelled";
  }
}

/**
 * Thrown by a background call that a person's pause reached before its
 * vendor call. Nothing ran, so the caller can make the call again after
 * the resume.
 */
export class CallHeld extends Error {
  constructor() {
    super("A pause holds the call until the resume.");
    this.name = "CallHeld";
  }
}

/** Thrown when an agent call failed twice; the caller stops with a report. */
export class AgentFailed extends Error {
  constructor(
    readonly role: AgentRole,
    readonly vendor: Vendor,
    message: string,
  ) {
    super(message);
    this.name = "AgentFailed";
  }
}

/** Thrown when a vendor's safety filter refused a call. Repeating the call gets the same answer. */
export class SafetyRefused extends AgentFailed {
  constructor(role: AgentRole, vendor: Vendor, message: string) {
    super(role, vendor, message);
    this.name = "SafetyRefused";
  }
}

/** Thrown when the server denied a lease with `fail_role`. */
export class RoleDenied extends Error {
  constructor(
    readonly role: AgentRole,
    readonly vendor: Vendor,
    reason: string,
  ) {
    super(`The server refused a ${role} call on ${vendor}: ${reason}`);
    this.name = "RoleDenied";
  }
}

/** Thrown when an adapter ran past its timeout and didn't stop by itself. */
export class CallTimeout extends Error {
  constructor(ms: number) {
    super(`The agent call ran past its ${Math.round(ms / 1000)} second timeout.`);
    this.name = "CallTimeout";
  }
}

/** A decision about a vendor limit or ceiling: resume or cancel. */
export function ceilingDecision(message: string): DecisionNeeded {
  return new DecisionNeeded({
    kind: "ceiling",
    findingIds: [],
    options: ["resume", "cancel"],
    message,
  });
}

/** An error's message for a log line, on one line and at most 500 characters. */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 500 ? `${line.slice(0, 497)}...` : line;
}
