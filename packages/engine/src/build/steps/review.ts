// The review step: one review pipeline run on the build diff, in the build
// worktree. The Developer seat fills the fixer role, as a fresh agent with
// the task context in its prompt. A clean run moves the build on; anything
// else becomes an escalation that names the run.
//
// The run's id is saved in `review/run.json` before the run starts, so a
// restarted engine waits for the same run, which the run manager continues,
// instead of starting another one. A retry after a run that ended without
// reporting the diff clean keeps that record as `review/run-ID.json`, and the
// step starts a new run.
import { rename } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  EngineRunCreateSchema,
  type Escalation,
  type EscalationResolve,
  type RunState,
  type RunStatus,
  type StopReason,
} from "@aio/contracts";
import { RunCancelled } from "../../calls/index.js";
import { EngineError } from "../../api/core-interface.js";
import { RangeError as ReviewRangeError } from "../../range/resolve.js";
import { commandKey, loadBaseline, type BaselineTests, type TestBaseline } from "../baseline.js";
import type { BuildContext, ReviewRuns } from "../context.js";
import { escalationForCallError } from "../escalations.js";
import { ulid } from "../ids.js";
import type { StepOutcome } from "./types.js";

/** The seat that fills the review run's fixer role. */
export const REVIEW_FIXER_SEAT = "developer";

/** How often the step reads its run's state by default. */
export const REVIEW_POLL_MS = 2000;

/** The run statuses the step stops waiting at. */
const SETTLED: readonly RunStatus[] = ["waiting_decision", "finished", "failed", "cancelled"];

/**
 * The stop reasons that report the build diff clean. A run that ends clean
 * with follow-ups passed the same test as a clean one, with findings that no
 * vendor would check: release ready lists them in the pull request for the
 * owner, who reviews it before any merge.
 */
export const CLEAN_REVIEW: readonly StopReason[] = [
  "clean",
  "clean_above_floor",
  "clean_with_followups",
];

/** What `review/run.json` holds. */
interface ReviewRecord {
  runId: string;
}

/** The fixer's task context: the build plan's title, criteria, and tasks. */
export function reviewTaskContext(ctx: BuildContext): string {
  const { plan } = ctx;
  const criteria = new Map(plan.criteria.map((c) => [c.id, c.text]));
  const lines = [
    `This change is the build "${plan.title}" on the branch ${ctx.state.branch}. Keep each fix within the task it belongs to.`,
  ];
  for (const task of plan.tasks) {
    lines.push(
      "",
      `Task ${task.id}: ${task.title}`,
      task.description,
      `Owned files: ${task.ownedFiles.join(", ")}`,
      "Acceptance criteria:",
      ...task.criteria.map((id) => `- ${id}: ${criteria.get(id) ?? ""}`),
    );
  }
  return lines.join("\n");
}

/**
 * The baseline's known failing and flaky tests, as failure lines by test
 * command. A line that names one of `protect`, the tasks' own tests, or that
 * a command naming one gave, never counts as excused: the build exists to
 * make those pass.
 */
function excusedTests(baseline: TestBaseline, protect: readonly string[]): BaselineTests[] {
  const byCommand = new Map<string, BaselineTests>();
  const add = (command: string, cwd: string | null, failure: string) => {
    if (protect.some((path) => command.includes(path) || failure.includes(path))) return;
    const key = commandKey({ command, cwd });
    const entry = byCommand.get(key) ?? { command, cwd, failures: [] };
    if (!entry.failures.includes(failure)) entry.failures.push(failure);
    byCommand.set(key, entry);
  };
  for (const e of baseline.knownFailing) for (const f of e.failures) add(e.command, e.cwd, f);
  for (const e of baseline.flaky) add(e.command, e.cwd, e.failure);
  return [...byCommand.values()];
}

/** Starts the build's review run with the run id `runId`. */
async function startRun(ctx: BuildContext, runs: ReviewRuns, runId: string): Promise<void> {
  const placement = ctx.seats.place(REVIEW_FIXER_SEAT);
  await runs.start(
    EngineRunCreateSchema.parse({
      runId,
      projectId: ctx.state.projectId,
      repoPath: ctx.worktree.path,
      base: ctx.state.base,
      tip: ctx.state.branch,
      roles: { fixer: placement.vendor },
      build: {
        buildId: ctx.state.id,
        fixer: { placement: { ...placement, fresh: true }, context: reviewTaskContext(ctx) },
        gate: {
          tests: ctx.plan.commands.test,
          typecheck: ctx.plan.commands.typecheck,
          lint: ctx.plan.commands.lint,
          excused: excusedTests(
            await loadBaseline(ctx.store),
            ctx.plan.tasks.flatMap((t) => t.tests),
          ),
        },
      },
    }),
  );
}

/** Waits until the run stops at a decision or ends. */
async function settled(ctx: BuildContext, runs: ReviewRuns, runId: string): Promise<RunState> {
  const pollMs = ctx.services.reviewPollMs ?? REVIEW_POLL_MS;
  for (;;) {
    const run = await runs.get(runId);
    if (!run) throw new Error(`The build's review run ${runId} is missing.`);
    if (SETTLED.includes(run.status)) return run;
    try {
      await sleep(pollMs, undefined, { signal: ctx.signal });
    } catch {
      throw new RunCancelled();
    }
  }
}

/** Why the run didn't report the build diff clean, in one line. */
function summaryOf(run: RunState): string {
  if (run.status === "waiting_decision") {
    return `The review run needs a decision (${run.decision?.kind ?? "unknown"}).`;
  }
  if (run.status === "finished") {
    return `The review run ended without reporting the diff clean (${run.stopReason ?? "unknown"}).`;
  }
  return `The review run is ${run.status}${run.error ? `: ${run.error}` : "."}`;
}

/** Everything the resolver needs to find and answer the run. */
function detailsOf(run: RunState): string {
  const lines = [
    `Review run: ${run.id}`,
    `Run files: .aio/runs/${run.id}/`,
    `Status: ${run.status}`,
    `Stop reason: ${run.stopReason ?? "none"}`,
    `Round: ${run.round}`,
  ];
  if (run.decision) {
    lines.push(
      `Decision: ${run.decision.kind}`,
      `Findings: ${run.decision.findingIds.join(", ") || "none"}`,
      `Options: ${run.decision.options.join(", ")}`,
      "",
      run.decision.message,
    );
  }
  if (run.error) lines.push("", `Error: ${run.error}`);
  return lines.join("\n");
}

/**
 * The build's review run: the one that `review/run.json` names, started when
 * the run manager doesn't know it, or a new one when the file is missing.
 * Returns the run's ID, or `null` when the run can't start and the build
 * escalated with `kind`.
 */
export async function ensureRun(
  ctx: BuildContext,
  runs: ReviewRuns,
  kind: "review" | "release_ready",
): Promise<string | null> {
  const file = ctx.store.path("review", "run.json");
  let record = await ctx.store.readJson<ReviewRecord>(file);
  if (!record) {
    record = { runId: ulid(ctx.services.clock.now()) };
    await ctx.store.writeJson(file, record);
  }
  if (!(await runs.get(record.runId))) {
    try {
      await startRun(ctx, runs, record.runId);
    } catch (error) {
      const draft = escalationForCallError(error, null);
      if (draft) {
        await ctx.escalate(draft);
        return null;
      }
      if (!(error instanceof EngineError) && !(error instanceof ReviewRangeError)) throw error;
      await ctx.escalate({
        kind,
        level: "project_manager",
        taskId: null,
        summary: `The review run can't start: ${error.message}`,
        details: `Review run: ${record.runId}\n\n${error.message}`,
      });
      return null;
    }
  }
  return record.runId;
}

/** The review step. */
export async function runReview(ctx: BuildContext): Promise<StepOutcome> {
  const runs = ctx.services.reviews;
  if (!runs) throw new Error("This engine has no review runs for the build's review step.");
  const runId = await ensureRun(ctx, runs, "review");
  if (runId === null) return "wait";
  const run = await settled(ctx, runs, runId);
  if (run.status === "finished" && run.stopReason && CLEAN_REVIEW.includes(run.stopReason)) {
    return "next";
  }
  await ctx.escalate({
    kind: "review",
    level: "project_manager",
    taskId: null,
    runId: run.id,
    summary: summaryOf(run),
    details: detailsOf(run),
  });
  return "wait";
}

/** Turns a refusal of the run manager into one the build request reports. */
async function asRequest<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof EngineError) throw error;
    const code = (error as { code?: unknown }).code === "invalid_state" ? "invalid_state" : null;
    if (code) throw new EngineError(code, (error as Error).message);
    throw error;
  }
}

/**
 * Prepares the review run that an escalation names for the step to wait on
 * it again: answers its decision, continues it when it failed, or, when it
 * ended without reporting the diff clean, sets the step to start a new run.
 * Throws `EngineError` for a retry of a run that waits for a decision.
 */
export async function reopenRun(
  ctx: BuildContext,
  escalation: Escalation,
  request: EscalationResolve,
  ended: (run: RunState) => "rerun" | "keep",
): Promise<void> {
  const runs = ctx.services.reviews;
  const run = escalation.runId && runs ? await runs.get(escalation.runId) : null;
  if (!runs || !run) return;
  if (request.action === "decide" && request.decision) {
    const decision = request.decision;
    await asRequest(() => runs.decide(run.id, decision));
    return;
  }
  if (run.status === "waiting_decision") {
    throw new EngineError(
      "validation",
      `Review run ${run.id} waits for a decision (${run.decision?.kind ?? "unknown"}). Answer it with decide and one of: ${run.decision?.options.join(", ") ?? "none"}.`,
    );
  }
  if (run.status === "failed") {
    await asRequest(() => runs.retry(run.id, {}));
    return;
  }
  if (ended(run) === "rerun") {
    const file = ctx.store.path("review", "run.json");
    await rename(file, ctx.store.path("review", `run-${run.id}.json`));
  }
}

/** Prepares the review step to run again after its escalation was resolved. */
export function reopenReview(
  ctx: BuildContext,
  escalation: Escalation,
  request: EscalationResolve,
): Promise<void> {
  return reopenRun(ctx, escalation, request, (run) =>
    run.status === "finished" || run.status === "cancelled" ? "rerun" : "keep",
  );
}
