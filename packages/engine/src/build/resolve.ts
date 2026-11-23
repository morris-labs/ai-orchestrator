// Resolving an escalation: the resolve request records a decision on one
// open escalation and prepares what it paused to run again. The controller
// then resumes the build.
//
// The Project manager resolves what the build plan already covers: retries,
// task order, and clarifications. A decision that changes the acceptance
// criteria, the scope, or the milestones belongs to the owner, so the engine
// marks such an escalation for the owner instead of resolving it, and an
// escalation for the owner takes only a decision that names the owner.
import {
  OWNER_PLAN_CHANGES,
  type Escalation,
  type EscalationKind,
  type EscalationResolve,
} from "@aio/contracts";
import { EngineError } from "../api/core-interface.js";
import type { BuildContext } from "./context.js";
import { reopenReleaseReady } from "./steps/release-ready.js";
import { reopenReview } from "./steps/review.js";
import { reopenTask } from "./steps/tasks.js";
import { reopenTestsFirst } from "./steps/tests-first.js";

/** What a resolve request did: resolved the escalation, or handed it to the owner. */
export type ResolveOutcome = "resolved" | "owner";

/** Prepares a step's work to run again; throws `EngineError` to refuse the resolution. */
type Reopen = (
  ctx: BuildContext,
  escalation: Escalation,
  request: EscalationResolve,
) => Promise<void>;

/** The kinds whose step keeps files that a resolution must change before the step runs again. */
const REOPEN: Partial<Record<EscalationKind, Reopen>> = {
  review: reopenReview,
  release_ready: reopenReleaseReady,
  tests_first: reopenTestsFirst,
};

function refuse(message: string): never {
  throw new EngineError("validation", message);
}

/** Checks a new task order: every task that isn't done, once, each after the tasks it depends on. */
function checkOrder(ctx: BuildContext, order: readonly string[]): void {
  const known = new Set(ctx.plan.tasks.map((t) => t.id));
  const unknown = order.filter((id) => !known.has(id));
  if (unknown.length > 0) refuse(`The build plan has no task ${unknown.join(", ")}.`);
  if (new Set(order).size !== order.length) refuse("The task order lists a task twice.");
  const done = new Set(ctx.state.tasks.filter((t) => t.status === "done").map((t) => t.id));
  const missing = ctx.plan.tasks.filter((t) => !done.has(t.id) && !order.includes(t.id));
  if (missing.length > 0) {
    refuse(`The task order leaves out ${missing.map((t) => t.id).join(", ")}, which aren't done.`);
  }
  const placed = new Set(done);
  for (const id of order) {
    const task = ctx.plan.tasks.find((t) => t.id === id);
    const early = task?.dependsOn.filter((dep) => !placed.has(dep)) ?? [];
    if (early.length > 0) {
      refuse(`Task ${id} depends on ${early.join(", ")}, so it can't run before them.`);
    }
    placed.add(id);
  }
}

/**
 * Refuses to run a placement escalation's work again while the plan breaks
 * the single-vendor setting: the seat would fail to place the same way.
 */
function checkPlacementRetry(ctx: BuildContext, escalation: Escalation): void {
  const single = ctx.state.placements.singleVendor;
  const conflicts = ctx.seats.singleVendorConflicts();
  if (!single || conflicts.length === 0) return;
  const seats = conflicts
    .map((c) =>
      c.level === "plan"
        ? `the build plan places the ${c.seat} seat on ${c.vendor}`
        : `a live change places the ${c.seat} seat on ${c.vendor}`,
    )
    .join("; ");
  const fields = conflicts
    .filter((c) => c.level === "plan")
    .map((c) => `placements.${c.seat}.vendor`);
  const change =
    fields.length > 0
      ? `Remove ${fields.join(" and ")} from the build plan, or set singleVendor to null, in a new build.`
      : "Turn off the single-vendor setting or place the seat on it.";
  refuse(
    `A retry of escalation ${escalation.id} would fail the same way: ${seats}, but the single-vendor setting places every seat on ${single}. ${change} Cancel this build, or hand the escalation to the owner.`,
  );
}

/** Checks that the request fits the escalation. */
function checkRequest(ctx: BuildContext, escalation: Escalation, request: EscalationResolve): void {
  if (request.action === "reorder") {
    if (!escalation.taskId) refuse(`Escalation ${escalation.id} has no task to reorder around.`);
    checkOrder(ctx, request.order ?? []);
  }
  if (request.action === "decide" && !escalation.runId) {
    refuse(
      `Escalation ${escalation.id} isn't about a review run, so it has no decision to answer.`,
    );
  }
  if (escalation.kind === "placement" && request.action !== "escalate") {
    checkPlacementRetry(ctx, escalation);
  }
  if (request.push !== undefined && escalation.kind !== "release_ready") {
    refuse("Only a release ready escalation records the push answer.");
  }
  if (request.push !== undefined && request.by !== "owner") {
    refuse("The push answer is the owner's. Record it with the owner's decision.");
  }
}

/**
 * Resolves escalation `request.escalation` of the build, or marks it for the
 * owner. Throws `EngineError`: `not_found` for an unknown escalation,
 * `invalid_state` for one that is resolved, and `validation` for a request
 * that doesn't fit it.
 */
export async function resolveEscalation(
  ctx: BuildContext,
  request: EscalationResolve,
): Promise<ResolveOutcome> {
  const escalation = ctx.state.escalations.find((e) => e.id === request.escalation);
  if (!escalation) {
    throw new EngineError(
      "not_found",
      `Build ${ctx.state.slug} has no escalation ${request.escalation}.`,
    );
  }
  if (escalation.status !== "open") {
    throw new EngineError("invalid_state", `Escalation ${escalation.id} is resolved already.`);
  }
  const now = new Date(ctx.services.clock.now()).toISOString();
  const ownerChanges = request.changes.filter((c) => OWNER_PLAN_CHANGES.includes(c));
  if (escalation.level === "owner" && request.by !== "owner") {
    refuse(
      `Escalation ${escalation.id} waits for the owner. Ask the owner, then record the owner's decision.`,
    );
  }
  if (request.action === "escalate" && request.by === "owner") {
    refuse(`Escalation ${escalation.id} is with the owner already.`);
  }
  if (request.by !== "owner" && (request.action === "escalate" || ownerChanges.length > 0)) {
    escalation.level = "owner";
    escalation.ownerReason =
      ownerChanges.length > 0
        ? `The Project manager's decision changes the ${ownerChanges.join(", ")}, which only the owner decides.${request.note ? ` ${request.note}` : ""}`
        : (request.note ?? "The Project manager handed the escalation to the owner.");
    await ctx.saveEscalation(escalation);
    return "owner";
  }
  checkRequest(ctx, escalation, request);
  if (request.push === undefined && escalation.kind === "release_ready" && ctx.plan.push === null) {
    refuse("The build plan has no push answer. Record the owner's answer to resolve this.");
  }
  await REOPEN[escalation.kind]?.(ctx, escalation, request);
  if (request.push !== undefined) await ctx.recordPush(request.push);
  if (request.action === "reorder" && request.order) ctx.state.taskOrder = request.order;
  reopenTask(ctx, escalation);
  escalation.status = "resolved";
  escalation.resolution = {
    action: request.action,
    by: request.by,
    ...(request.note !== undefined ? { note: request.note } : {}),
    ...(request.order !== undefined ? { order: request.order } : {}),
    ...(request.decision !== undefined ? { decision: request.decision } : {}),
    ...(request.push !== undefined ? { push: request.push } : {}),
    changes: request.changes,
    resolvedAt: now,
  };
  // The task statuses change in the same turn as the escalation's status.
  await ctx.refreshTaskStatuses();
  await ctx.saveEscalation(escalation);
  return "resolved";
}
