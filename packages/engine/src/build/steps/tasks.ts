// The tasks step: each task in dependency order, one at a time, worked by
// its seat's agent and checked by the task gate, up to the attempt cap. The
// gate also runs the tests that earlier tasks made pass.
//
// Every attempt saves a file as it goes: its start before the agent call,
// the agent's answer after it, and the gate result last. A restarted build
// reads those files and continues from the last finished part; the call
// cache returns a finished agent call without calling again.
import { taskOrder, type BuildTask } from "@aio/contracts";
import { RunCancelled } from "../../calls/index.js";
import { untrusted } from "../../prompts/templates.js";
import { loadBaseline, quarantine } from "../baseline.js";
import type { BuildContext } from "../context.js";
import { escalationForCallError } from "../escalations.js";
import {
  gateFailureLine,
  gateReport,
  runTaskGate,
  type EarlierTask,
  type TaskGateResult,
} from "../gate.js";
import { writablePaths, type RoleTask } from "../roles/index.js";
import { readTestLock } from "../test-lock.js";
import type { StepOutcome } from "./types.js";

/** Attempts a task gets before it escalates. */
export const ATTEMPT_CAP = 4;

/** One attempt at a task, as `tasks/TASK/attempt-N.json` saves it. */
export interface AttemptRecord {
  attempt: number;
  /** The worktree's `HEAD` when the attempt started. */
  start: string;
  /** The agent call's cache key. */
  callKey: string;
  /** The seat's answer, once the call finished. */
  answer?: { vendor: string; model: string; output: Record<string, unknown> };
  /** The gate result, once the gate ran. */
  gate?: TaskGateResult;
}

type GatedAttempt = AttemptRecord & { gate: TaskGateResult };

function roleTask(ctx: BuildContext, task: BuildTask, context: string): RoleTask {
  const criteria = new Map(ctx.plan.criteria.map((c) => [c.id, c.text]));
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    repoPath: ctx.worktree.path,
    branch: ctx.state.branch,
    ownedFiles: task.ownedFiles,
    contracts: task.contracts,
    criteria: task.criteria.map((id) => ({ id, text: criteria.get(id) ?? "" })),
    tests: task.tests,
    context,
  };
}

/** The context for attempt `n`: the attempt count and the last attempt's gate failures. */
function attemptContext(n: number, previous: AttemptRecord | undefined): string {
  const lines = [`This is attempt ${n} of ${ATTEMPT_CAP} at this task.`];
  if (previous?.gate && !previous.gate.passed) {
    lines.push(
      "",
      "The task gate failed the last attempt. Its report follows; your work from that attempt is still in the worktree unless the report says otherwise.",
      "",
      untrusted(gateReport(previous.gate)),
    );
  }
  return lines.join("\n");
}

/**
 * The other tasks, as the gate of `task` sees them: the tasks that finished,
 * whose tests must still pass, and the test files of the tasks that haven't,
 * which may still fail.
 */
function otherTasks(
  ctx: BuildContext,
  task: BuildTask,
): { earlier: EarlierTask[]; pending: string[] } {
  const others = ctx.plan.tasks.filter((t) => t.id !== task.id);
  const done = (t: BuildTask) => ctx.task(t.id).status === "done";
  return {
    earlier: others.filter(done).map((t) => ({ id: t.id, tests: t.tests })),
    pending: others.filter((t) => !done(t)).flatMap((t) => t.tests),
  };
}

/** Runs attempt `n`, or returns its saved result when it already finished. */
async function attempt(ctx: BuildContext, task: BuildTask, n: number): Promise<GatedAttempt> {
  const path = ctx.store.attemptPath(task.id, n);
  let record = await ctx.store.readJson<AttemptRecord>(path);
  if (record?.gate) return record as GatedAttempt;
  const progress = ctx.task(task.id);
  if (!record) {
    record = { attempt: n, start: await ctx.worktree.head(), callKey: `${task.id}-attempt-${n}` };
    await ctx.store.writeJson(path, record);
    progress.attempts = n;
    await ctx.persist();
  }
  const previous =
    n > 1
      ? await ctx.store.readJson<AttemptRecord>(ctx.store.attemptPath(task.id, n - 1))
      : undefined;
  const specialties = await ctx.specialties(task.specialties);
  const outcome = await ctx.callSeat({
    seat: task.role,
    specialties,
    key: record.callKey,
    step: "tasks",
    task: roleTask(ctx, task, attemptContext(n, previous)),
  });
  record.answer = { vendor: outcome.vendor, model: outcome.model, output: outcome.output };
  await ctx.store.writeJson(path, record);
  await ctx.calls.checkpoint();
  const signal = ctx.signal;
  const gate = await runTaskGate({
    worktree: ctx.worktree,
    base: progress.base ?? ctx.state.base,
    writable: writablePaths(ctx.role(task.role), roleTask(ctx, task, "")),
    commands: ctx.plan.commands,
    lock: await readTestLock(ctx.store),
    shell: ctx.services.shell,
    baseline: await loadBaseline(ctx.store),
    protect: task.tests,
    ...otherTasks(ctx, task),
    signal,
  });
  // A gate that the engine stopped part way says nothing about the attempt.
  if (signal.aborted) throw new RunCancelled();
  await quarantine(
    ctx.store,
    (gate.quarantined ?? []).map((t) => ({
      ...t,
      source: { at: "gate", taskId: task.id, attempt: n },
    })),
  );
  const gated: GatedAttempt = { ...record, gate };
  await ctx.store.writeJson(path, gated);
  return gated;
}

/**
 * Works one task to a passing gate. Returns `"wait"` when the task
 * escalated, and the build must wait for a decision.
 */
async function runTask(ctx: BuildContext, task: BuildTask): Promise<StepOutcome> {
  const progress = ctx.task(task.id);
  if (progress.status === "done") return "next";
  if (progress.status === "failed") return "wait";
  if (progress.status === "pending") {
    progress.base = await ctx.worktree.head();
    await ctx.setTaskStatus(task.id, "running");
  }
  const base = progress.base ?? ctx.state.base;
  for (let n = Math.max(progress.attempts, 1); n <= ATTEMPT_CAP; n += 1) {
    await ctx.calls.checkpoint();
    let record: GatedAttempt;
    try {
      record = await attempt(ctx, task, n);
    } catch (error) {
      const draft = escalationForCallError(error, task.id);
      if (!draft) throw error;
      progress.lastFailure = draft.summary;
      await ctx.setTaskStatus(task.id, "failed");
      await ctx.escalate(draft);
      return "wait";
    }
    if (record.gate.passed) {
      if (await ctx.worktree.dirty()) {
        await ctx.worktree.commitAll(`chore(build): finish task ${task.id}, ${task.title}`);
      }
      progress.commit = await ctx.worktree.head();
      delete progress.lastFailure;
      await ctx.setTaskStatus(task.id, "done");
      return "next";
    }
    // The seat may not change files outside its writable paths: the engine
    // puts them back, so the next attempt starts within bounds.
    if (!record.gate.permission.passed) {
      await ctx.worktree.restorePaths(base, record.gate.permission.outside);
    }
    // Nor change a locked test: the engine puts it back the way the lock has it.
    if (record.gate.lock && !record.gate.lock.passed) {
      const lock = await readTestLock(ctx.store);
      if (lock) await ctx.worktree.restorePaths(lock.commit, record.gate.lock.changed);
    }
    progress.lastFailure = gateFailureLine(record.gate);
    await ctx.persist();
  }
  const last = await ctx.store.readJson<AttemptRecord>(ctx.store.attemptPath(task.id, ATTEMPT_CAP));
  await ctx.setTaskStatus(task.id, "failed");
  await ctx.escalate({
    kind: "attempt_cap",
    level: "project_manager",
    taskId: task.id,
    summary: `Task ${task.id} failed the task gate on all ${ATTEMPT_CAP} attempts.`,
    details: [
      `Last failure: ${progress.lastFailure ?? "unknown"}`,
      "",
      last?.gate ? gateReport(last.gate) : "",
      "",
      `Attempt files: ${Array.from({ length: ATTEMPT_CAP }, (_, i) => `tasks/${task.id}/attempt-${i + 1}.json`).join(", ")}`,
    ].join("\n"),
  });
  return "wait";
}

/** The tasks step: every task in dependency order, one at a time. */
export async function runTasks(ctx: BuildContext): Promise<StepOutcome> {
  for (const task of taskOrder(ctx.plan.tasks)) {
    if ((await runTask(ctx, task)) === "wait") return "wait";
  }
  return "next";
}
