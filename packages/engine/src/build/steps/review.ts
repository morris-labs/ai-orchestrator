// The review step: one review pipeline run on the build diff, in the build
// worktree. The Developer seat fills the fixer role, as a fresh agent with
// the task context in its prompt. A clean run moves the build on; anything
// else becomes an escalation that names the run.
//
// The run's id is saved in `review/run.json` before the run starts, so a
// restarted engine waits for the same run, which the run manager continues,
// instead of starting another one.
import { setTimeout as sleep } from "node:timers/promises";
import {
  EngineRunCreateSchema,
  type RunState,
  type RunStatus,
  type StopReason,
} from "@aio/contracts";
import { RunCancelled } from "../../calls/index.js";
import { EngineError } from "../../api/core-interface.js";
import { RangeError as ReviewRangeError } from "../../range/resolve.js";
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

/** The stop reasons that report the build diff clean. */
const CLEAN: readonly StopReason[] = ["clean", "clean_above_floor"];

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

/** The review step. */
export async function runReview(ctx: BuildContext): Promise<StepOutcome> {
  const runs = ctx.services.reviews;
  if (!runs) throw new Error("This engine has no review runs for the build's review step.");
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
        return "wait";
      }
      if (!(error instanceof EngineError) && !(error instanceof ReviewRangeError)) throw error;
      await ctx.escalate({
        kind: "review",
        level: "project_manager",
        taskId: null,
        summary: `The review run can't start: ${error.message}`,
        details: `Review run: ${record.runId}\n\n${error.message}`,
      });
      return "wait";
    }
  }
  const run = await settled(ctx, runs, record.runId);
  if (run.status === "finished" && run.stopReason && CLEAN.includes(run.stopReason)) {
    return "next";
  }
  await ctx.escalate({
    kind: "review",
    level: "project_manager",
    taskId: null,
    summary: summaryOf(run),
    details: detailsOf(run),
  });
  return "wait";
}
