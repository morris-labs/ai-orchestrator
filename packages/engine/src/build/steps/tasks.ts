// The tasks step: each task in dependency order, one at a time, worked by
// its seat's agent and checked by the task gate, up to the attempt cap. The
// gate also runs the tests that earlier tasks made pass.
//
// Every attempt saves a file as it goes: its start before the agent call,
// the agent's answer after it, and the gate result last. A restarted build
// reads those files and continues from the last finished part; the call
// cache returns a finished agent call without calling again.
//
// When the gate fails two attempts in a row on one failure fingerprint, the
// engine seats the Debugger before the next attempt, and that attempt's
// prompt carries the diagnosis.
//
// A task that escalates pauses with every task that depends on it, and the
// step goes on with the tasks that don't. The step waits once no task can
// run. A resolve request resumes the paused tasks (see `reopenTask()`).
import { digestMilestones } from "../digests.js";
import { existsSync } from "node:fs";
import { taskOrder, type BuildTask, type Escalation } from "@aio/contracts";
import { RunCancelled } from "../../calls/index.js";
import { untrusted } from "../../prompts/templates.js";
import { loadBaseline, quarantine } from "../baseline.js";
import type { BuildContext } from "../context.js";
import { diagnose, diagnosisText, readDiagnosis, type DiagnosisRecord } from "../debugger.js";
import {
  disputeContext,
  disputeFile,
  disputeOf,
  nextDisputeId,
  openDispute,
  settleDispute,
  type DisputeRecord,
} from "../disputes.js";
import { escalationForCallError, type EscalationDraft } from "../escalations.js";
import { failureFingerprint, sameFingerprint } from "../fingerprint.js";
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

/** Attempts a task gets before it escalates, and the attempts a retry adds. */
export const ATTEMPT_CAP = 4;

/** What a task needs that the build doesn't have, as the seat reports it. */
export interface Blocker {
  kind: "secret" | "service";
  name: string;
  reason: string;
}

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
  /** What the seat reported it needs, in place of the gate. */
  blocked?: Blocker;
  /** The test dispute that the seat raised, in place of the gate; the attempt runs again once it's settled. */
  dispute?: number;
  /** The test dispute that the attempt runs again after. */
  after?: number;
}

type GatedAttempt = AttemptRecord & { gate: TaskGateResult };
type FinishedAttempt =
  GatedAttempt | (AttemptRecord & { blocked: Blocker }) | (AttemptRecord & { dispute: number });

/** The last attempt `task` gets. */
function capOf(ctx: BuildContext, taskId: string): number {
  return ctx.task(taskId).attemptCap ?? ATTEMPT_CAP;
}

/** The seat's report of a missing secret or service, or `null` when it reports none. */
function blockerOf(output: Record<string, unknown>): Blocker | null {
  const blocked = output.blocked;
  if (typeof blocked !== "object" || blocked === null) return null;
  const { kind, name, reason } = blocked as Record<string, unknown>;
  if ((kind !== "secret" && kind !== "service") || typeof name !== "string") return null;
  return { kind, name, reason: typeof reason === "string" ? reason : "" };
}

/** The Project manager's clarifications for a task, from its resolved escalations. */
function clarifications(ctx: BuildContext, taskId: string): string[] {
  return ctx.state.escalations.flatMap((e) =>
    e.taskId === taskId && e.resolution?.action === "clarify" && e.resolution.note
      ? [e.resolution.note]
      : [],
  );
}

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
    dependsOn: task.dependsOn.map((id) => ({
      id,
      title: ctx.plan.tasks.find((t) => t.id === id)?.title ?? "",
    })),
    context,
  };
}

/**
 * The context for attempt `n`: the attempt count, the last attempt's gate
 * failures, and the Debugger's diagnosis when the last two attempts failed
 * the same way.
 */
function attemptContext(
  n: number,
  cap: number,
  previous: AttemptRecord | undefined,
  diagnosis: DiagnosisRecord | undefined,
  notes: readonly string[],
  dispute?: string,
): string {
  const lines = [`This is attempt ${n} of ${cap} at this task.`];
  for (const note of notes) {
    lines.push("", "The Project manager clarified the task:", "", untrusted(note));
  }
  if (dispute) lines.push("", dispute);
  if (previous?.gate && !previous.gate.passed) {
    lines.push(
      "",
      "The task gate failed the last attempt. Its report follows; your work from that attempt is still in the worktree unless the report says otherwise.",
      "",
      untrusted(gateReport(previous.gate)),
    );
  }
  if (diagnosis) {
    lines.push(
      "",
      `The gate failed attempts ${diagnosis.attempt - 1} and ${diagnosis.attempt} the same way, so the Debugger diagnosed the failure. Apply its fix in this attempt:`,
      "",
      untrusted(diagnosisText(diagnosis)),
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

/** The context about the dispute that an attempt runs again after, or `undefined` for none. */
async function settledDispute(
  ctx: BuildContext,
  task: BuildTask,
  id: number | undefined,
): Promise<string | undefined> {
  if (id === undefined) return undefined;
  const record = await ctx.store.readJson<DisputeRecord>(ctx.store.path(disputeFile(task.id, id)));
  if (!record) return undefined;
  return disputeContext(
    record,
    ctx.state.escalations.find((e) => e.id === record.escalation),
  );
}

/**
 * Settles the test dispute that attempt `n` raised, then starts the attempt
 * again with a call of its own. The attempt count stays as it is. Returns
 * `"wait"` when the dispute escalated.
 */
async function afterDispute(
  ctx: BuildContext,
  task: BuildTask,
  n: number,
  id: number,
): Promise<"again" | "wait"> {
  // A dispute file that a stop kept from being saved is saved from the answer.
  const path = ctx.store.attemptPath(task.id, n);
  const saved = await ctx.store.readJson<AttemptRecord>(path);
  const claim = saved?.answer ? disputeOf(saved.answer.output) : null;
  if (claim) await openDispute(ctx, task, id, n, claim);
  if ((await settleDispute(ctx, task, id)) === "wait") return "wait";
  await ctx.store.writeJson(path, {
    attempt: n,
    start: await ctx.worktree.head(),
    callKey: `${task.id}-attempt-${n}-after-dispute-${id}`,
    after: id,
  } satisfies AttemptRecord);
  return "again";
}

/** An attempt whose task an escalation paused during its call; it goes on from the saved answer. */
const PAUSED = "paused";

/**
 * Runs attempt `n`, or returns its saved result when it already finished.
 * An attempt whose seat reports a missing secret or service ends without
 * the gate. An attempt whose task an escalation paused during the call,
 * such as a question past the cap, returns `PAUSED` without the gate; once
 * the escalation is resolved, the call cache returns the same answer and
 * the gate runs then.
 */
async function attempt(
  ctx: BuildContext,
  task: BuildTask,
  n: number,
): Promise<FinishedAttempt | typeof PAUSED> {
  const path = ctx.store.attemptPath(task.id, n);
  let record = await ctx.store.readJson<AttemptRecord>(path);
  if (record?.gate || record?.blocked || record?.dispute !== undefined) {
    return record as FinishedAttempt;
  }
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
  const diagnosis = n > 1 ? await readDiagnosis(ctx, task.id, n - 1) : undefined;
  const specialties = await ctx.specialties(task.specialties);
  const outcome = await ctx.callSeat({
    seat: task.role,
    specialties,
    key: record.callKey,
    step: "tasks",
    task: roleTask(
      ctx,
      task,
      attemptContext(
        n,
        capOf(ctx, task.id),
        previous,
        diagnosis,
        clarifications(ctx, task.id),
        await settledDispute(ctx, task, record.after),
      ),
    ),
  });
  record.answer = { vendor: outcome.vendor, model: outcome.model, output: outcome.output };
  if (progress.status !== "running") {
    await ctx.store.writeJson(path, record);
    return PAUSED;
  }
  const blocked = blockerOf(outcome.output);
  if (blocked) {
    const finished = { ...record, blocked };
    await ctx.store.writeJson(path, finished);
    return finished;
  }
  // A test dispute doesn't count as an attempt: the gate doesn't run, and
  // the attempt runs again once the dispute is settled.
  const claim = disputeOf(outcome.output);
  if (claim) {
    const finished = { ...record, dispute: await nextDisputeId(ctx, task.id) };
    await ctx.store.writeJson(path, finished);
    await openDispute(ctx, task, finished.dispute, n, claim);
    return finished;
  }
  await ctx.store.writeJson(path, record);
  await ctx.calls.checkpoint();
  const signal = ctx.signal;
  const lock = await readTestLock(ctx.store);
  // A test that a dispute of this task amended changed since the task's
  // base, but the engine changed it, so the permission check leaves it be.
  const amended = (lock?.amendments ?? []).filter((a) => a.taskId === task.id).map((a) => a.test);
  const gate = await runTaskGate({
    worktree: ctx.worktree,
    base: progress.base ?? ctx.state.base,
    writable: [...writablePaths(ctx.role(task.role), roleTask(ctx, task, "")), ...amended],
    commands: ctx.plan.commands,
    lock,
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
 * The escalation for attempt `n` when it broke a test that an earlier task
 * made pass, and an earlier attempt at the task broke the same test: the
 * task oscillates between that test and its own. `null` otherwise.
 */
async function oscillation(
  ctx: BuildContext,
  task: BuildTask,
  n: number,
  gate: TaskGateResult,
): Promise<EscalationDraft | null> {
  for (const regression of gate.regressions ?? []) {
    for (let before = 1; before < n; before += 1) {
      const record = await ctx.store.readJson<AttemptRecord>(
        ctx.store.attemptPath(task.id, before),
      );
      const again = record?.gate?.regressions?.some(
        (r) => r.taskId === regression.taskId && r.test === regression.test,
      );
      if (!again) continue;
      return {
        kind: "oscillation",
        level: "project_manager",
        taskId: task.id,
        summary: `Task ${task.id} broke ${regression.test}, which task ${regression.taskId} made pass, again in attempt ${n} after attempt ${before}.`,
        details: [
          `Task ${regression.taskId} made ${regression.test} pass. Task ${task.id} broke it in attempts ${before} and ${n}, so the two tasks pull the code in different directions. Decide which behavior the plan wants, then change the plan or the tasks.`,
          "",
          gateReport(gate),
          "",
          `Attempt files: tasks/${task.id}/attempt-${before}.json, tasks/${task.id}/attempt-${n}.json`,
        ].join("\n"),
      };
    }
  }
  return null;
}

/**
 * Fails the task with the escalation for an agent call's error, and returns
 * `"wait"`. Throws the error when it isn't one that a person resolves.
 */
async function failOnCallError(
  ctx: BuildContext,
  taskId: string,
  error: unknown,
): Promise<StepOutcome> {
  const draft = escalationForCallError(error, taskId);
  if (!draft) throw error;
  ctx.task(taskId).lastFailure = draft.summary;
  await ctx.escalate(draft);
  return "wait";
}

/**
 * The fingerprint of attempt `n`'s gate failure when attempt `n - 1` failed
 * on the same one, and `null` otherwise. Lines that the baseline excuses or
 * that the gate quarantined don't count.
 */
async function repeatedFailure(
  ctx: BuildContext,
  task: BuildTask,
  n: number,
  gate: TaskGateResult,
): Promise<string[] | null> {
  if (n < 2) return null;
  const previous = await ctx.store.readJson<AttemptRecord>(ctx.store.attemptPath(task.id, n - 1));
  if (!previous?.gate || previous.gate.passed) return null;
  const options = { baseline: await loadBaseline(ctx.store), protect: task.tests };
  const fingerprint = failureFingerprint(gate, options);
  return sameFingerprint(fingerprint, failureFingerprint(previous.gate, options))
    ? fingerprint
    : null;
}

/** The escalation for a task whose seat reports a missing secret or service. */
function blockerEscalation(task: BuildTask, n: number, blocked: Blocker): EscalationDraft {
  const what = blocked.kind === "secret" ? "secret" : "external service";
  return {
    kind: blocked.kind === "secret" ? "missing_secret" : "missing_service",
    level: "owner",
    taskId: task.id,
    summary: `Task ${task.id} needs the ${what} ${blocked.name}, which the build doesn't have.`,
    details: [
      `The ${what} ${blocked.name} is missing. The seat stopped instead of working around it.`,
      blocked.kind === "secret"
        ? "Tick the secret for the project in the box's Secrets (project) section, then resolve the escalation with a retry."
        : "Make the service reachable from the project's container, then resolve the escalation with a retry.",
      "",
      `Reason: ${blocked.reason || "none given"}`,
      "",
      `Attempt file: tasks/${task.id}/attempt-${n}.json`,
    ].join("\n"),
  };
}

/** The diagnosis files of a task's attempts up to `last`, as build-relative paths. */
async function diagnosisFiles(ctx: BuildContext, taskId: string, last: number): Promise<string[]> {
  const files: string[] = [];
  for (let n = 1; n <= last; n += 1) {
    if (await ctx.store.readJson(ctx.store.diagnosisPath(taskId, n))) {
      files.push(`tasks/${taskId}/diagnosis-${n}.json`);
    }
  }
  return files;
}

/**
 * Works one task to a passing gate. Returns `"wait"` when the task
 * escalated, and it and its dependents wait for a decision.
 */
async function runTask(ctx: BuildContext, task: BuildTask): Promise<StepOutcome> {
  const progress = ctx.task(task.id);
  if (progress.status === "done") return "next";
  if (progress.status === "failed" || progress.status === "blocked") return "wait";
  if (progress.status === "pending") {
    progress.base = await ctx.worktree.head();
    await ctx.setTaskStatus(task.id, "running");
  }
  if (progress.setAside) await bringBack(ctx, task, progress.setAside);
  const base = progress.base ?? ctx.state.base;
  const cap = capOf(ctx, task.id);
  const first = Math.max(progress.attempts, progress.resumeAt ?? 1, 1);
  for (let n = first; n <= cap; n += 1) {
    await ctx.calls.checkpoint();
    let finished: FinishedAttempt | typeof PAUSED;
    try {
      finished = await attempt(ctx, task, n);
    } catch (error) {
      return failOnCallError(ctx, task.id, error);
    }
    if (finished === PAUSED) return "wait";
    const record = finished;
    if (record.blocked) {
      progress.lastFailure = `Needs the ${record.blocked.kind} ${record.blocked.name}.`;
      await ctx.escalate(blockerEscalation(task, n, record.blocked));
      return "wait";
    }
    // An escalation that came in after the call, such as during a dispute
    // or a message turn, pauses the task. Once it's resolved, the task goes
    // on from this attempt's saved result.
    if (progress.status !== "running") return "wait";
    if (record.dispute !== undefined) {
      let next: "again" | "wait";
      try {
        next = await afterDispute(ctx, task, n, record.dispute);
      } catch (error) {
        return failOnCallError(ctx, task.id, error);
      }
      if (next === "wait") return "wait";
      // The same attempt runs again.
      n -= 1;
      continue;
    }
    const gated = record as GatedAttempt;
    if (gated.gate.passed) {
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
    if (!gated.gate.permission.passed) {
      await ctx.worktree.restorePaths(base, gated.gate.permission.outside);
    }
    // Nor change a locked test: the engine puts it back the way the lock has it.
    if (gated.gate.lock && !gated.gate.lock.passed) {
      const lock = await readTestLock(ctx.store);
      if (lock) await ctx.worktree.restorePaths(lock.commit, gated.gate.lock.changed);
    }
    progress.lastFailure = gateFailureLine(gated.gate);
    await ctx.persist();
    const oscillating = await oscillation(ctx, task, n, gated.gate);
    if (oscillating) {
      await ctx.escalate(oscillating);
      return "wait";
    }
    if (n === cap) break;
    const repeated = await repeatedFailure(ctx, task, n, gated.gate);
    if (!repeated) continue;
    await ctx.calls.checkpoint();
    try {
      await diagnose(ctx, task, n, repeated, gated.gate);
    } catch (error) {
      return failOnCallError(ctx, task.id, error);
    }
  }
  const last = await ctx.store.readJson<AttemptRecord>(ctx.store.attemptPath(task.id, cap));
  const attempts = Array.from({ length: cap }, (_, i) => `tasks/${task.id}/attempt-${i + 1}.json`);
  const diagnoses = await diagnosisFiles(ctx, task.id, cap);
  await ctx.escalate({
    kind: "attempt_cap",
    level: "project_manager",
    taskId: task.id,
    summary: `Task ${task.id} failed the task gate on all ${cap} attempts.`,
    details: [
      `Last failure: ${progress.lastFailure ?? "unknown"}`,
      "",
      last?.gate ? gateReport(last.gate) : "",
      "",
      `Attempt files: ${attempts.join(", ")}`,
      `Diagnosis files: ${diagnoses.join(", ") || "none"}`,
    ].join("\n"),
  });
  return "wait";
}

/**
 * Sets aside the work of each task that waits for its own escalation, so the
 * next task starts from a worktree without it. The waiting task gets it back
 * when it runs again.
 */
async function setAsideWaiting(ctx: BuildContext): Promise<void> {
  for (const progress of ctx.state.tasks) {
    if (progress.status !== "failed" || progress.setAside || !progress.base) continue;
    // A test that a dispute of the task amended is locked as amended, so it
    // stays: the next task's lock check expects it.
    const lock = await readTestLock(ctx.store);
    const amended = (lock?.amendments ?? [])
      .filter((a) => a.taskId === progress.id)
      .map((a) => a.test);
    // A task without changes gets an entry too: its base moves past the
    // tasks that run meanwhile, so its permission check leaves their work alone.
    const file = `tasks/${progress.id}/set-aside-${progress.attempts}.patch`;
    await ctx.worktree.setAside(
      progress.base,
      ctx.store.path(file),
      `chore(build): set task ${progress.id} aside while it waits for an escalation`,
      amended,
    );
    progress.setAside = file;
    await ctx.persist();
  }
}

/**
 * Gives a task back the work that `setAsideWaiting()` saved, on top of the
 * tasks that ran since, which its new base covers.
 */
async function bringBack(ctx: BuildContext, task: BuildTask, file: string): Promise<void> {
  const progress = ctx.task(task.id);
  progress.base = await ctx.worktree.head();
  const patch = ctx.store.path(file);
  if (existsSync(patch) && !(await ctx.worktree.bringBack(patch))) {
    ctx.services.log.warn("A task's set-aside work no longer applies; the task starts without it", {
      build: ctx.state.slug,
      task: task.id,
      patch: file,
    });
  }
  delete progress.setAside;
  await ctx.persist();
}

/** The plan's tasks in the order they run: a resolution's order, else plan order, after their dependencies. */
function orderedTasks(ctx: BuildContext): BuildTask[] {
  const order = ctx.state.taskOrder;
  if (!order) return taskOrder(ctx.plan.tasks);
  const rank = (id: string) => {
    const at = order.indexOf(id);
    return at < 0 ? -1 : at;
  };
  return taskOrder([...ctx.plan.tasks].sort((a, b) => rank(a.id) - rank(b.id)));
}

/** The next task that can run: not done, not paused, and every task it depends on done. */
function nextTask(ctx: BuildContext): BuildTask | undefined {
  const done = (id: string) => ctx.task(id).status === "done";
  return orderedTasks(ctx).find((task) => {
    const status = ctx.task(task.id).status;
    return (status === "pending" || status === "running") && task.dependsOn.every(done);
  });
}

/**
 * The tasks step: every task in dependency order, one at a time. A task that
 * escalates doesn't stop the tasks that don't depend on it; the step waits
 * once no task can run.
 */
export async function runTasks(ctx: BuildContext): Promise<StepOutcome> {
  for (let task = nextTask(ctx); task; task = nextTask(ctx)) {
    await ctx.calls.checkpoint();
    await setAsideWaiting(ctx);
    await runTask(ctx, task);
    await digestMilestones(ctx);
  }
  // A restarted engine finishes a digest that a stop left unwritten.
  await digestMilestones(ctx);
  if (ctx.state.tasks.every((t) => t.status === "done")) return "next";
  if (ctx.openEscalations().length === 0) {
    throw new Error("The build has tasks that can't run, and no escalation explains why.");
  }
  await ctx.waitForEscalations();
  return "wait";
}

/** Kinds of task escalation that a finished attempt raised; a retry goes on with the next attempt. */
const AFTER_ATTEMPT: ReadonlySet<Escalation["kind"]> = new Set([
  "attempt_cap",
  "oscillation",
  "missing_secret",
  "missing_service",
]);

/**
 * Prepares a task to run again after its escalation was resolved. After an
 * attempt that finished, the task goes on with the next attempt and gets
 * `ATTEMPT_CAP` more; after an agent call that stopped, the attempt runs
 * again.
 */
export function reopenTask(ctx: BuildContext, escalation: Escalation): void {
  if (!escalation.taskId || !AFTER_ATTEMPT.has(escalation.kind)) return;
  const progress = ctx.task(escalation.taskId);
  progress.resumeAt = progress.attempts + 1;
  progress.attemptCap = Math.max(capOf(ctx, progress.id), progress.attempts + ATTEMPT_CAP);
}
