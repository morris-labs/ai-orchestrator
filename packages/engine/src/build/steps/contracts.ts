// The Contracts step: before tests first in a medium or large build, a
// Developer writes the shared types and interfaces that the plan's tasks list
// as contracts, with stubs, so the Test engineer's tests compile against the
// real signatures and fail on assertions. A small build, and a plan whose
// tasks list no contract files, skip the step.
//
// The Developer may change the contract files and the tasks' owned files,
// for the stubs, but no test path: tests first writes the tests. The task
// gate checks each attempt: the plan's test, type check, and lint commands
// must pass, or fail only the way the preflight baseline records. Once an
// attempt passes, the engine commits the contracts, so tests first starts
// from them.
//
// Every attempt saves `contracts/attempt-N.json` as it goes: its start
// before the agent call, the answer after it, and the gate result last. A
// restarted build continues from the last finished part.
import type { BuildPlan, Escalation } from "@aio/contracts";
import { RunCancelled } from "../../calls/index.js";
import { untrusted } from "../../prompts/templates.js";
import { loadBaseline, quarantine } from "../baseline.js";
import type { BuildContext } from "../context.js";
import { escalationForCallError } from "../escalations.js";
import { gateFailureLine, gateReport, runTaskGate, type TaskGateResult } from "../gate.js";
import { pathMatcher } from "../paths.js";
import { writablePaths, type RoleTask } from "../roles/index.js";
import { setupNote } from "../test-command.js";
import { ATTEMPT_CAP } from "./tasks.js";
import type { StepOutcome } from "./types.js";

/** The seat that writes the contracts. */
export const CONTRACTS_SEAT = "developer";

/** The task ID that the Contracts step's calls and flaky tests name. */
const CONTRACTS_ID = "contracts";

/** One attempt of the Contracts step, as `contracts/attempt-N.json` saves it. */
export interface ContractsAttempt {
  attempt: number;
  /** The worktree's `HEAD` when the attempt started. */
  start: string;
  callKey: string;
  answer?: { vendor: string; model: string; output: Record<string, unknown> };
  gate?: TaskGateResult;
}

type GatedAttempt = ContractsAttempt & { gate: TaskGateResult };

/** An attempt file, relative to the build directory. */
export function contractsAttemptFile(attempt: number): string {
  return `contracts/attempt-${attempt}.json`;
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/** The contract files of every task in the plan, in plan order. */
export function contractFiles(plan: Pick<BuildPlan, "tasks">): string[] {
  return unique(plan.tasks.flatMap((task) => task.contracts));
}

/** True when the plan runs the Contracts step: a medium or large build with contract files. */
export function runsContracts(plan: Pick<BuildPlan, "size" | "tasks">): boolean {
  return plan.size !== "small" && contractFiles(plan).length > 0;
}

/** The plan's test paths and globs, which the Contracts step may not change. */
function testPaths(ctx: BuildContext): string[] {
  return unique(ctx.plan.tasks.flatMap((task) => task.tests));
}

/**
 * The paths the Developer may change: the contract files, and the tasks'
 * owned files for the stubs, without the paths that the tasks list as tests.
 */
function stepFiles(ctx: BuildContext): string[] {
  const tests = new Set(testPaths(ctx));
  const owned = ctx.plan.tasks.flatMap((task) => task.ownedFiles);
  return unique([...contractFiles(ctx.plan), ...owned]).filter((path) => !tests.has(path));
}

/** The Project manager's clarifications for the step, from its resolved escalations. */
function clarifications(ctx: BuildContext): string[] {
  return ctx.state.escalations.flatMap((e) =>
    e.kind === "contracts" && e.resolution?.action === "clarify" && e.resolution.note
      ? [e.resolution.note]
      : [],
  );
}

function roleTask(ctx: BuildContext, context: string): RoleTask {
  const files = contractFiles(ctx.plan);
  const users = (path: string) =>
    ctx.plan.tasks.filter((task) => task.contracts.includes(path)).map((task) => task.id);
  return {
    id: CONTRACTS_ID,
    title: `Contracts for ${ctx.plan.title}`,
    description: [
      "This is the Contracts step: write the shared types and interfaces that the tasks implement, before any test or code for them exists.",
      "For each contract file, write the types, schemas, interfaces, and function signatures that the tasks need, as the architecture describes them.",
      "Where a task's code doesn't exist yet, add a stub with the real signature in that task's owned files, such as a function, a method, a route, or a command, so the tests compile and import against it.",
      "Make each stub return a value of its declared type that doesn't meet the criteria, such as an empty list or the input unchanged, so a test of it fails on an assertion, not on an error.",
      "Don't implement the behavior, and don't write or change tests: the Test engineer writes them next, against your contracts.",
      "Existing code and tests must keep working, so the plan's test, type check, and lint commands must pass as they did before.",
      `The contract files, with the tasks that implement each: ${files.map((f) => `${f} (${users(f).join(", ")})`).join("; ")}.`,
      setupNote(ctx.plan.commands),
    ].join(" "),
    repoPath: ctx.worktree.path,
    branch: ctx.state.branch,
    ownedFiles: stepFiles(ctx),
    contracts: files,
    criteria: ctx.plan.criteria.map((c) => ({ id: c.id, text: c.text })),
    context,
  };
}

function attemptContext(
  n: number,
  cap: number,
  previous: ContractsAttempt | undefined,
  notes: readonly string[],
): string {
  const lines = [`This is attempt ${n} of ${cap} of the Contracts step.`];
  for (const note of notes) {
    lines.push("", "The Project manager clarified the step:", "", untrusted(note));
  }
  if (previous?.gate && !previous.gate.passed) {
    lines.push(
      "",
      "The gate failed the last attempt. Its report follows; your work from that attempt is still in the worktree unless the report says otherwise.",
      "",
      untrusted(gateReport(previous.gate)),
    );
  }
  return lines.join("\n");
}

/**
 * Runs the task gate over the step's changes. A changed file under a test
 * path fails the permission check, whatever the writable paths say.
 */
async function gate(ctx: BuildContext, base: string, task: RoleTask): Promise<TaskGateResult> {
  const result = await runTaskGate({
    worktree: ctx.worktree,
    base,
    writable: writablePaths(ctx.role(CONTRACTS_SEAT), task),
    commands: ctx.plan.commands,
    lock: null,
    shell: ctx.services.shell,
    baseline: await loadBaseline(ctx.store),
    signal: ctx.signal,
  });
  const isTest = pathMatcher(testPaths(ctx));
  const tests = (await ctx.worktree.changedSince(base)).filter(isTest);
  if (tests.length === 0) return result;
  return {
    ...result,
    passed: false,
    permission: {
      ...result.permission,
      passed: false,
      outside: unique([...result.permission.outside, ...tests]).sort(),
    },
  };
}

/** Runs attempt `n`, or returns its saved result when it already finished. */
async function attempt(
  ctx: BuildContext,
  n: number,
  cap: number,
  base: () => Promise<string>,
): Promise<GatedAttempt> {
  const path = ctx.store.path(contractsAttemptFile(n));
  let record = await ctx.store.readJson<ContractsAttempt>(path);
  if (record?.gate) return record as GatedAttempt;
  const progress = ctx.state.contracts;
  if (!record) {
    record = {
      attempt: n,
      start: await ctx.worktree.head(),
      callKey: `${CONTRACTS_ID}-attempt-${n}`,
    };
    await ctx.store.writeJson(path, record);
    if (progress) progress.attempts = n;
    await ctx.persist();
  }
  const previous =
    n > 1
      ? await ctx.store.readJson<ContractsAttempt>(ctx.store.path(contractsAttemptFile(n - 1)))
      : undefined;
  const task = roleTask(ctx, attemptContext(n, cap, previous, clarifications(ctx)));
  const outcome = await ctx.callSeat({
    seat: CONTRACTS_SEAT,
    specialties: await ctx.specialties(unique(ctx.plan.tasks.flatMap((t) => t.specialties))),
    key: record.callKey,
    step: "contracts",
    task,
    // The contracts serve every task, so a message about any of them reaches this agent.
    taskIds: ctx.plan.tasks.map((t) => t.id),
  });
  record.answer = { vendor: outcome.vendor, model: outcome.model, output: outcome.output };
  await ctx.store.writeJson(path, record);
  await ctx.calls.checkpoint();
  const result = await gate(ctx, await base(), task);
  // A gate that the engine stopped part way says nothing about the attempt.
  if (ctx.signal.aborted) throw new RunCancelled();
  await quarantine(
    ctx.store,
    (result.quarantined ?? []).map((t) => ({
      ...t,
      source: { at: "gate", taskId: CONTRACTS_ID, attempt: n },
    })),
  );
  const gated: GatedAttempt = { ...record, gate: result };
  await ctx.store.writeJson(path, gated);
  return gated;
}

/** The Contracts step. */
export async function runContracts(ctx: BuildContext): Promise<StepOutcome> {
  if (!runsContracts(ctx.plan)) {
    if (ctx.state.contracts?.status !== "skipped") {
      ctx.state.contracts = { status: "skipped", attempts: 0 };
      await ctx.persist();
    }
    return "next";
  }
  ctx.state.contracts ??= { status: "running", attempts: 0 };
  const progress = ctx.state.contracts;
  if (progress.status === "done" || progress.status === "skipped") return "next";
  if (progress.status === "failed") return "wait";
  // Every attempt's permission check covers the changes since the step started.
  const base = async () =>
    (await ctx.store.readJson<ContractsAttempt>(ctx.store.path(contractsAttemptFile(1))))?.start ??
    (await ctx.worktree.head());
  const cap = progress.attemptCap ?? ATTEMPT_CAP;
  for (let n = Math.max(progress.attempts, 1); n <= cap; n += 1) {
    await ctx.calls.checkpoint();
    let record: GatedAttempt;
    try {
      record = await attempt(ctx, n, cap, base);
    } catch (error) {
      const draft = escalationForCallError(error, null);
      if (!draft) throw error;
      await ctx.escalate(draft);
      return "wait";
    }
    if (record.gate.passed) {
      if (await ctx.worktree.dirty()) {
        await ctx.worktree.commitAll(`feat(build): add the contracts for ${ctx.plan.title}`);
      }
      progress.status = "done";
      progress.commit = await ctx.worktree.head();
      delete progress.lastFailure;
      await ctx.persist();
      return "next";
    }
    // The engine puts back the files the Developer may not change, so the
    // next attempt starts within bounds.
    if (!record.gate.permission.passed) {
      await ctx.worktree.restorePaths(await base(), record.gate.permission.outside);
    }
    progress.lastFailure = gateFailureLine(record.gate);
    await ctx.persist();
  }
  progress.status = "failed";
  await ctx.persist();
  const last = await ctx.store.readJson<ContractsAttempt>(
    ctx.store.path(contractsAttemptFile(cap)),
  );
  const files = Array.from({ length: cap }, (_, i) => contractsAttemptFile(i + 1));
  await ctx.escalate({
    kind: "contracts",
    level: "project_manager",
    taskId: null,
    summary: `The Contracts step failed the task gate on all ${cap} attempts.`,
    details: [
      `Last failure: ${progress.lastFailure ?? "unknown"}`,
      "",
      last?.gate ? gateReport(last.gate) : "",
      "",
      `Attempt files: ${files.join(", ")}`,
    ].join("\n"),
  });
  return "wait";
}

/**
 * Prepares the Contracts step to run again after its escalation was
 * resolved: the step goes on with the next attempt and gets `ATTEMPT_CAP`
 * more.
 */
export async function reopenContracts(ctx: BuildContext, _escalation: Escalation): Promise<void> {
  const progress = ctx.state.contracts;
  if (!progress || progress.status !== "failed") return;
  progress.status = "running";
  progress.attemptCap = progress.attempts + ATTEMPT_CAP;
  await ctx.persist();
}
