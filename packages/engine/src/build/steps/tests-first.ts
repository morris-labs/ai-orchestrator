// The tests first step: the Test engineer writes the tests from the
// acceptance criteria before any Developer starts. The engine checks each
// round of tests and sends them back with the problems it found, up to the
// round cap:
//
// - Each test names a criterion of the plan, and its file mentions that ID.
// - Each criterion with a test verification has at least one test.
// - A test in a file that a task lists checks one of that task's criteria,
//   so the task that must make it pass owns the code it tests.
// - The red check: each test fails on an assertion against the stubs.
// - The plan's type check and lint commands pass with the tests in place,
//   except where they fail only as they did at preflight. A Developer can't
//   change a locked test, so a test that fails them would fail every task
//   gate.
//
// When a round passes in a medium or large build, the coverage check reads
// each criterion with its tests, on another vendor. The Test engineer revises
// once for the criteria it reports, and the revision goes through the same
// checks. Then the engine commits the tests and records the test lock, which
// the task gate holds every Developer to.
//
// Every round saves `tests-first/round-N.json` as it goes: its start before
// the agent call, the answer after it, and the check last. A restarted build
// continues from the last finished part.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { BuildCriterion } from "@aio/contracts";
import { RunCancelled } from "../../calls/index.js";
import { untrusted } from "../../prompts/templates.js";
import type { BuildContext } from "../context.js";
import { escalationForCallError } from "../escalations.js";
import { checkFailsOnlyOnBaseline, loadBaseline } from "../baseline.js";
import { outsideWritable } from "../gate.js";
import { pathMatcher } from "../paths.js";
import { runGateCommand } from "../../gate/gate.js";
import { runRedCheck, type ListedTest, type RedCheck } from "../red-check.js";
import { landedWhileWaiting, seatWaits } from "../seat-wait.js";
import { setupNote, testEnvironmentNote } from "../test-command.js";
import type { RoleTask } from "../roles/index.js";
import { lockFiles, readTestLock, writeTestLock } from "../test-lock.js";
import { COVERAGE_REPORT_FILE, runCoverageCheck, type CoverageReport } from "./coverage-check.js";
import type { StepOutcome } from "./types.js";

/** Rounds the Test engineer gets before tests first escalates. */
export const TESTS_FIRST_ROUND_CAP = 3;

/** The seat that writes the tests. */
export const TEST_ENGINEER = "test-engineer";

/** Where a retry after an escalation starts: `tests-first/retry.json`. */
const RETRY_FILE = "tests-first/retry.json";

interface RetryRecord {
  /** The first round of the retry. */
  from: number;
}

/** A round's checks: the red check, with the other problems the engine found first. */
export interface RoundCheck extends RedCheck {
  /** Changed files outside the test paths, which the engine put back. */
  outside: string[];
}

/** One round of tests first, as `tests-first/round-N.json` saves it. */
export interface RoundRecord {
  round: number;
  /** The worktree's `HEAD` when the round started. */
  start: string;
  /** The worktree's `HEAD` when the Test engineer's turn began. */
  turn?: string;
  /** The worktree's `HEAD` when the Test engineer's turn ended. */
  end?: string;
  callKey: string;
  answer?: { vendor: string; model: string; output: Record<string, unknown> };
  check?: RoundCheck;
}

export type CheckedRound = RoundRecord & { check: RoundCheck };

/** A round file, relative to the build directory. */
export function roundFile(round: number): string {
  return `tests-first/round-${round}.json`;
}

/** What one tests first run works from. */
export interface Scope {
  /** The commit tests first started from; the permission check covers every change since. */
  base: string;
  /** The criteria that an automated test verifies. */
  criteria: BuildCriterion[];
  /** The test paths and globs that the plan's tasks list, which the Test engineer may change. */
  paths: string[];
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function roleTask(ctx: BuildContext, scope: Scope, context: string): RoleTask {
  return {
    id: "tests-first",
    title: `Tests first for ${ctx.plan.title}`,
    description: [
      "Write the tests for these acceptance criteria before any code for them exists. Each test must fail on an assertion against the stubs.",
      "The plan's type check and lint commands must pass with your tests in place, because no Developer can change a locked test.",
      ctx.state.contracts?.status === "done"
        ? "The Contracts step wrote the contracts and their stubs, and committed them: import the real signatures from them, and test through them."
        : "",
      testEnvironmentNote(ctx.plan.commands),
      setupNote(ctx.plan.commands),
    ]
      .filter(Boolean)
      .join(" "),
    repoPath: ctx.worktree.path,
    branch: ctx.state.branch,
    ownedFiles: scope.paths,
    contracts: unique(ctx.plan.tasks.flatMap((task) => task.contracts)),
    criteria: scope.criteria.map((c) => ({
      id: c.id,
      text: c.alreadyHolds
        ? `${c.text} (This criterion already holds: its tests can pass before the change.)`
        : c.text,
    })),
    context,
  };
}

/** The failures of a round, for the next round's prompt. */
function roundReport(check: RoundCheck): string {
  const lines = ["Problems:", ...check.problems.map((p) => `- ${p}`)];
  for (const test of check.tests.filter((t) => t.outcome !== "failed")) {
    lines.push(
      "",
      `Output of \`${test.command}\` for "${test.name}" (${test.outcome}):`,
      test.outputTail,
    );
  }
  return lines.join("\n");
}

/** The context of the one revision after the coverage check. */
function revisionContext(report: CoverageReport): string {
  return [
    "This is the coverage revision of tests first: your one revision after the coverage check.",
    "",
    "An agent on another vendor read each criterion with your tests and reported the criteria that the tests don't check, in the report that follows. Revise the tests so that each of these criteria has a test that fails when the criterion doesn't hold. Your tests are still in the worktree. Answer with every test, the old ones included.",
    "",
    untrusted(report.gaps.map((gap) => `- ${gap.criterion}: ${gap.reason}`).join("\n")),
  ].join("\n");
}

function roundContext(n: number, last: number, previous: RoundRecord | undefined): string {
  const lines = [`This is round ${n} of ${last} of tests first.`];
  if (previous?.check && !previous.check.passed) {
    lines.push(
      "",
      "The engine's checks sent the last round's tests back. Fix each problem in the report that follows. Your files from that round are still in the worktree, except files outside the test paths, which the engine put back.",
      "",
      untrusted(roundReport(previous.check)),
    );
  }
  return lines.join("\n");
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * The paths that other seats committed while tests first waited for the
 * Test engineer, in rounds 1 to `last`: the Test engineer didn't change them.
 */
async function othersCommits(ctx: BuildContext, last: number): Promise<string[]> {
  const rounds: RoundRecord[] = [];
  for (let n = 1; n <= last; n += 1) {
    const record = await ctx.store.readJson<RoundRecord>(ctx.store.path(roundFile(n)));
    if (record) rounds.push(record);
  }
  return landedWhileWaiting(ctx.worktree, seatWaits(rounds));
}

/**
 * Checks the tests a round's answer lists, then runs the red check over the
 * ones that pass those checks. Changed files outside the test paths are put
 * back first, so the tests run against the stubs, except the files that
 * other seats committed while the round waited for its seat.
 */
async function checkRound(
  ctx: BuildContext,
  scope: Scope,
  n: number,
  output: Record<string, unknown>,
): Promise<RoundCheck> {
  const problems: string[] = [];
  const outside = outsideWritable(
    await ctx.worktree.changedSince(scope.base),
    scope.paths,
    await othersCommits(ctx, n),
  );
  if (outside.length > 0) {
    await ctx.worktree.restorePaths(scope.base, outside);
    problems.push(
      `These changed files are outside the test paths, so the engine put them back: ${outside.join(", ")}.`,
    );
  }
  const known = new Set(scope.criteria.map((c) => c.id));
  const listed: ListedTest[] = [];
  const entries: unknown[] = Array.isArray(output.tests) ? output.tests : [];
  if (!Array.isArray(output.tests)) problems.push("The report has no list of tests.");
  for (const [index, entry] of entries.entries()) {
    const fields =
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const file = text(fields.file);
    const name = text(fields.name);
    const criterion = text(fields.criterion);
    const command = text(fields.command);
    const named = `Test ${name ? `"${name}"` : index + 1}${file ? ` in ${file}` : ""}`;
    if (!file || !name || !command) {
      const missing = [!file && "file", !name && "name", !command && "command"].filter(Boolean);
      problems.push(`${named} has no ${missing.join(" or ")}.`);
      continue;
    }
    if (!criterion) {
      problems.push(`${named} names no criterion ID.`);
      continue;
    }
    if (!known.has(criterion)) {
      problems.push(
        `${named} names criterion ${criterion}, which isn't one of the criteria to test: ${[...known].join(", ")}.`,
      );
      continue;
    }
    if (outsideWritable([file], scope.paths).length > 0) {
      problems.push(`${named} is outside the test paths: ${scope.paths.join(", ")}.`);
      continue;
    }
    const content = await readText(join(ctx.worktree.path, file));
    if (content === null) {
      problems.push(`${named}: the file doesn't exist.`);
      continue;
    }
    if (!content.includes(criterion)) {
      problems.push(`${named}: the file doesn't mention criterion ID ${criterion}.`);
      continue;
    }
    const owners = ctx.plan.tasks.filter((task) => pathMatcher(task.tests)(file));
    if (owners.length > 0 && !owners.some((task) => task.criteria.includes(criterion))) {
      const ownersText = owners
        .map((task) => `task ${task.id}, which covers ${task.criteria.join(", ")}`)
        .join(", and ");
      const homes = unique(
        ctx.plan.tasks.filter((task) => task.criteria.includes(criterion)).flatMap((t) => t.tests),
      );
      problems.push(
        `${named} checks criterion ${criterion}, but ${file} belongs to ${ownersText}. That task can't make it pass. Move the test to a test file of a task that covers ${criterion}${homes.length > 0 ? `: ${homes.join(", ")}` : ""}.`,
      );
      continue;
    }
    listed.push({ file, name, criterion, command });
  }
  const tested = new Set(listed.map((t) => t.criterion));
  for (const criterion of scope.criteria.filter((c) => !tested.has(c.id))) {
    problems.push(`Criterion ${criterion.id} has no test.`);
  }
  const red = await runRedCheck({
    worktree: ctx.worktree,
    tests: listed,
    commands: ctx.plan.commands,
    holds: new Set(scope.criteria.filter((c) => c.alreadyHolds).map((c) => c.id)),
    shell: ctx.services.shell,
    signal: ctx.signal,
  });
  const all = [...problems, ...red.problems, ...(await checkCommands(ctx))];
  return { passed: all.length === 0, problems: all, tests: red.tests, outside };
}

/** Lines of a failed check that a problem quotes. */
const QUOTED_LINES = 10;

/**
 * Runs the plan's type check and lint commands over the round's tests, and
 * returns one problem for each that fails other than as it did at preflight.
 */
async function checkCommands(ctx: BuildContext): Promise<string[]> {
  const baseline = await loadBaseline(ctx.store);
  const problems: string[] = [];
  for (const kind of ["typecheck", "lint"] as const) {
    for (const cmd of ctx.plan.commands[kind]) {
      if (ctx.signal.aborted) return problems;
      const result = await runGateCommand(kind, cmd, {
        repoPath: ctx.worktree.path,
        shell: ctx.services.shell,
        signal: ctx.signal,
        diagnostics: true,
      });
      if (result.passed || checkFailsOnlyOnBaseline(result, baseline)) continue;
      const label = kind === "typecheck" ? "type check" : "lint command";
      const lines = result.diagnostics?.length
        ? result.diagnostics
        : result.outputTail.split("\n").filter((l) => l.trim() !== "");
      const quoted = lines.slice(0, QUOTED_LINES).join("\n");
      problems.push(
        `The ${label} \`${cmd.command}\` fails with the tests in place${result.timedOut ? " (it timed out)" : ""}:\n${quoted}`,
      );
    }
  }
  return problems;
}

/**
 * Runs round `n`, or returns its saved result when it already finished.
 * `context` gives the round's context from the round before it.
 */
async function round(
  ctx: BuildContext,
  scope: Scope,
  n: number,
  context: (previous: RoundRecord | undefined) => string,
): Promise<CheckedRound> {
  const path = ctx.store.path(roundFile(n));
  let record = await ctx.store.readJson<RoundRecord>(path);
  if (record?.check) return record as CheckedRound;
  if (!record) {
    record = { round: n, start: await ctx.worktree.head(), callKey: `tests-first-round-${n}` };
    await ctx.store.writeJson(path, record);
  }
  const previous =
    n > 1 ? await ctx.store.readJson<RoundRecord>(ctx.store.path(roundFile(n - 1))) : undefined;
  const specialties = await ctx.specialties(
    unique(ctx.plan.tasks.flatMap((task) => task.specialties)),
  );
  const waited = record;
  const outcome = await ctx.callSeat({
    seat: TEST_ENGINEER,
    specialties,
    key: record.callKey,
    step: "tests_first",
    task: roleTask(ctx, scope, context(previous)),
    // The Test engineer writes the tests of every task in scope, so a
    // message about any of them reaches this agent.
    taskIds: ctx.plan.tasks.map((task) => task.id),
    started: async () => {
      waited.turn = await ctx.worktree.head();
      await ctx.store.writeJson(path, waited);
    },
  });
  record.answer = { vendor: outcome.vendor, model: outcome.model, output: outcome.output };
  record.end = await ctx.worktree.head();
  await ctx.store.writeJson(path, record);
  await ctx.calls.checkpoint();
  const check = await checkRound(ctx, scope, n, outcome.output);
  // A check that the engine stopped part way says nothing about the round.
  if (ctx.signal.aborted) throw new RunCancelled();
  const checked: CheckedRound = { ...record, check };
  await ctx.store.writeJson(path, checked);
  return checked;
}

/** Commits the round's tests and records the test lock. */
async function lock(ctx: BuildContext, scope: Scope, record: CheckedRound): Promise<void> {
  if (await ctx.worktree.dirty()) {
    await ctx.worktree.commitAll(`test(build): add the tests first for ${ctx.plan.title}`);
  }
  const commit = await ctx.worktree.head();
  // Only test paths: other seats' commits since the base aren't tests.
  const changed = (await ctx.worktree.changedSince(scope.base)).filter(pathMatcher(scope.paths));
  const tests = record.check.tests.map(({ file, name, criterion, command }) => ({
    file,
    name,
    criterion,
    command,
  }));
  await writeTestLock(ctx.store, {
    commit,
    redCheck: roundFile(record.round),
    files: await lockFiles(ctx.worktree, [...tests.map((t) => t.file), ...changed]),
    tests,
    lockedAt: new Date(ctx.services.clock.now()).toISOString(),
  });
}

/**
 * Runs the coverage check on the round that passed the red check, except in
 * a small build, then the Test engineer's one revision when the check found
 * gaps, and locks the tests that passed.
 */
async function afterRedCheck(
  ctx: BuildContext,
  scope: Scope,
  passed: CheckedRound,
): Promise<StepOutcome> {
  if (ctx.plan.size === "small") {
    await lock(ctx, scope, passed);
    return "next";
  }
  await ctx.calls.checkpoint();
  const report = await runCoverageCheck(ctx, scope, passed);
  if (report.gaps.length === 0) {
    await lock(ctx, scope, passed);
    return "next";
  }
  await ctx.calls.checkpoint();
  const revision = await round(ctx, scope, passed.round + 1, () => revisionContext(report));
  if (revision.check.passed) {
    await lock(ctx, scope, revision);
    return "next";
  }
  await ctx.escalate({
    kind: "tests_first",
    level: "project_manager",
    taskId: null,
    summary: "The Test engineer's revision after the coverage check failed the engine's checks.",
    details: [
      roundReport(revision.check),
      "",
      `Coverage report: ${COVERAGE_REPORT_FILE}. Revision: ${roundFile(revision.round)}.`,
    ].join("\n"),
  });
  return "wait";
}

/** The tests first step. */
export async function runTestsFirst(ctx: BuildContext): Promise<StepOutcome> {
  if (await readTestLock(ctx.store)) return "next";
  const criteria = ctx.plan.criteria.filter((c) => c.verification === "test");
  if (criteria.length === 0) return "next";
  const paths = unique(ctx.plan.tasks.flatMap((task) => task.tests));
  if (paths.length === 0) {
    await ctx.escalate({
      kind: "tests_first",
      level: "project_manager",
      taskId: null,
      summary: "The build plan lists no test paths for the Test engineer to write.",
      details: `Criteria to test: ${criteria.map((c) => c.id).join(", ")}. Add the test files or globs to each task's tests.`,
    });
    return "wait";
  }
  const first = await ctx.store.readJson<RoundRecord>(ctx.store.path(roundFile(1)));
  const scope: Scope = { base: first?.start ?? (await ctx.worktree.head()), criteria, paths };
  const from = (await ctx.store.readJson<RetryRecord>(ctx.store.path(RETRY_FILE)))?.from ?? 1;
  const last = from + TESTS_FIRST_ROUND_CAP - 1;
  try {
    for (let n = from; n <= last; n += 1) {
      await ctx.calls.checkpoint();
      const record = await round(ctx, scope, n, (previous) => roundContext(n, last, previous));
      if (record.check.passed) return await afterRedCheck(ctx, scope, record);
    }
  } catch (error) {
    const draft = escalationForCallError(error, null);
    if (!draft) throw error;
    await ctx.escalate(draft);
    return "wait";
  }
  const lastRound = await ctx.store.readJson<RoundRecord>(ctx.store.path(roundFile(last)));
  await ctx.escalate({
    kind: "tests_first",
    level: "project_manager",
    taskId: null,
    summary: `The Test engineer's tests failed the engine's checks in all ${TESTS_FIRST_ROUND_CAP} rounds.`,
    details: [
      lastRound?.check ? roundReport(lastRound.check) : "",
      "",
      `Round files: ${Array.from({ length: TESTS_FIRST_ROUND_CAP }, (_, i) => roundFile(from + i)).join(", ")}`,
    ].join("\n"),
  });
  return "wait";
}

/**
 * Prepares tests first to run again after its escalation was resolved: the
 * Test engineer gets `TESTS_FIRST_ROUND_CAP` more rounds after the last one,
 * and a round that passes gets a new coverage check.
 */
export async function reopenTestsFirst(ctx: BuildContext): Promise<void> {
  let last = 0;
  while (await ctx.store.readJson(ctx.store.path(roundFile(last + 1)))) last += 1;
  await ctx.store.writeJson(ctx.store.path(RETRY_FILE), { from: last + 1 } satisfies RetryRecord);
  await rm(ctx.store.path(COVERAGE_REPORT_FILE), { force: true });
}
