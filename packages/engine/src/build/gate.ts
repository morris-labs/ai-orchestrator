// The task gate: the checks that decide whether a Developer attempt counts.
// It compares the task's changes with the role's writable paths, then runs
// the plan's test, type check, and lint commands in the build worktree.
//
// A failing test command runs once more. A test that fails and then passes
// is flaky: the gate quarantines it. A test command that fails only on known
// failing or flaky tests from the build's baseline doesn't fail the gate.
//
// When tests first locked the tests, the gate also checks the test lock.
//
// In a plan with several tasks, the gate also runs the tests that earlier
// tasks made pass, and a failure on one is a regression. A test command that
// names only tests of tasks that haven't run yet waits for those tasks:
// tests first wrote those tests red. While the test commands run, the gate
// sets those tests aside, so a command that runs the whole suite skips them.
//
// Later milestones add checks here: the failure fingerprint.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuildCommands, PolicyCommand } from "@aio/contracts";
import type { CommandRunner } from "../core.js";
import { runGateCommand, type GateCommandResult, type GateOptions } from "../gate/gate.js";
import {
  commandKey,
  emptyBaseline,
  excusedFailures,
  failsOnlyOnBaseline,
  testFailures,
  type TestBaseline,
} from "./baseline.js";
import { globToRegExp } from "../policy/glob.js";
import { checkLock, type LockCheck, type TestLock } from "./test-lock.js";
import type { BuildWorktree } from "./worktree.js";

/** The permission check: the changed paths that no writable glob covers. */
export interface PermissionCheck {
  passed: boolean;
  writable: string[];
  outside: string[];
}

/**
 * A command's result in the task gate. For a test command, `passed` is true
 * when the command passed, or failed only on baseline tests (`excused`).
 * After a rerun, the result is the rerun's, and `firstRun` holds the run
 * before it.
 */
export interface TaskGateCommand extends GateCommandResult {
  /** The baseline tests that the command failed on and that didn't fail the gate. */
  excused?: string[];
  /** The tests that failed in the first run and passed in the rerun. */
  quarantined?: string[];
  firstRun?: GateCommandResult;
}

/** A test that the gate found flaky, for the build's baseline. */
export interface QuarantinedTest {
  command: string;
  cwd: string | null;
  failure: string;
}

export interface TaskGateResult {
  passed: boolean;
  permission: PermissionCheck;
  /** The test lock check, when the build has a test lock. */
  lock?: LockCheck;
  commands: TaskGateCommand[];
  /** Tests that failed and then passed in a rerun. The caller adds them to the baseline. */
  quarantined?: QuarantinedTest[];
  /** Tests that earlier tasks made pass and that fail in this attempt. */
  regressions?: TaskRegression[];
  /** Test commands the gate didn't run: they name only tests of tasks that haven't run yet. */
  deferred?: string[];
  /** The test files of later tasks that the gate set aside while the test commands ran. */
  setAside?: string[];
  /** Untracked files the commands left, which the gate deleted. */
  leftovers: string[];
}

/** A test that an earlier task made pass, and that fails the gate of a later task. */
export interface TaskRegression {
  /** The earlier task. */
  taskId: string;
  /** The test file, from the earlier task's tests. */
  test: string;
  /** The test command that failed. */
  command: string;
}

/** A task that finished before the gated task, with its test files. */
export interface EarlierTask {
  id: string;
  tests: readonly string[];
}

export interface TaskGateOptions {
  worktree: BuildWorktree;
  /** The commit the task started from; the permission check covers every change since. */
  base: string;
  /** Repository-relative globs that the seat may change. */
  writable: readonly string[];
  commands: BuildCommands;
  /** The build's test lock; the gate fails an attempt that changes a locked file. */
  lock?: TestLock | null;
  /** Runs one command line through a shell. */
  shell: CommandRunner;
  /** The build's known failing and flaky tests. Absent means none. */
  baseline?: TestBaseline;
  /** The task's own test files: a failure that names one is never excused. */
  protect?: readonly string[];
  /** The tasks that finished before this one: their tests must still pass. */
  earlier?: readonly EarlierTask[];
  /** The test files of the tasks that haven't run yet: a test command that names only these waits. */
  pending?: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Runs one test command, and once more when it fails on a test the baseline
 * doesn't excuse. Lines of the first run that the rerun doesn't have go in
 * `quarantined`.
 */
async function runTestCommand(
  cmd: PolicyCommand,
  run: GateOptions,
  baseline: TestBaseline,
  protect: readonly string[],
): Promise<TaskGateCommand> {
  const excused = excusedFailures(baseline, cmd);
  const first = await runGateCommand("test", cmd, run);
  if (first.passed) return first;
  if (failsOnlyOnBaseline(first, excused, protect)) {
    return { ...first, passed: true, excused: testFailures(first) };
  }
  if (run.signal?.aborted) return first;
  const rerun = await runGateCommand("test", cmd, run);
  const still = new Set(testFailures(rerun));
  const quarantined = testFailures(first).filter((line) => !still.has(line));
  for (const line of quarantined) excused.add(line);
  const result: TaskGateCommand = { ...rerun, firstRun: first };
  if (quarantined.length > 0) result.quarantined = quarantined;
  if (failsOnlyOnBaseline(rerun, excused, protect)) {
    return { ...result, passed: true, excused: testFailures(rerun) };
  }
  return result;
}

/**
 * Sets aside the test files of later tasks, so that a test command that runs
 * the whole suite doesn't fail on tests that tests first wrote red for those
 * tasks. `restore()` puts each file back with the content it had. A glob, a
 * missing file, and a file that `protect` names stay in place.
 */
async function setAside(
  root: string,
  pending: readonly string[],
  protect: readonly string[],
): Promise<{ paths: string[]; restore(): Promise<void> }> {
  const saved = new Map<string, Buffer>();
  for (const path of [...new Set(pending)].sort()) {
    if (/[*?[]/.test(path) || protect.includes(path)) continue;
    try {
      saved.set(path, await readFile(join(root, path)));
    } catch {
      continue;
    }
    await rm(join(root, path));
  }
  return {
    paths: [...saved.keys()],
    async restore() {
      for (const [path, content] of saved) await writeFile(join(root, path), content);
    },
  };
}

/** True when `text` names one of `paths`. */
function names(text: string, paths: readonly string[]): boolean {
  return paths.some((path) => text.includes(path));
}

/** A test lock command that checks earlier tasks' tests. */
interface LockCommand {
  cmd: PolicyCommand;
  /** The earlier tasks and test files that the command checks. */
  owners: { taskId: string; test: string }[];
}

/**
 * The test commands that check earlier tasks' tests: each test that the
 * test lock lists for an earlier task, by its command, with the tasks and
 * files it checks.
 */

function earlierLockCommands(
  lock: TestLock | null | undefined,
  earlier: readonly EarlierTask[],
): Map<string, LockCommand> {
  const byCommand = new Map<string, LockCommand>();
  for (const test of lock?.tests ?? []) {
    for (const task of earlier.filter((t) => t.tests.includes(test.file))) {
      const cmd = { command: test.command };
      const key = commandKey(cmd);
      const entry: LockCommand = byCommand.get(key) ?? { cmd, owners: [] };
      entry.owners.push({ taskId: task.id, test: test.file });
      byCommand.set(key, entry);
    }
  }
  return byCommand;
}

/**
 * The earlier tasks' tests that the failing test commands broke: a command
 * that names an earlier task's test file, or has a failure line that names
 * one, or that the test lock lists for an earlier task's test.
 */
function findRegressions(
  commands: readonly TaskGateCommand[],
  earlier: readonly EarlierTask[],
  lockOwners: ReadonlyMap<string, LockCommand>,
): TaskRegression[] {
  const found = new Map<string, TaskRegression>();
  const add = (r: TaskRegression) => found.set(`${r.taskId}\0${r.test}`, r);
  for (const c of commands.filter((c) => c.kind === "test" && !c.passed)) {
    for (const owner of lockOwners.get(commandKey(c))?.owners ?? []) {
      add({ ...owner, command: c.command });
    }
    for (const task of earlier) {
      for (const test of task.tests) {
        if (c.command.includes(test) || c.failures.some((line) => line.includes(test))) {
          add({ taskId: task.id, test, command: c.command });
        }
      }
    }
  }
  return [...found.values()];
}

/** The changed paths that none of the `writable` globs cover. */
export function outsideWritable(changed: readonly string[], writable: readonly string[]): string[] {
  const patterns = writable.map((glob) => globToRegExp(glob));
  return changed.filter((path) => !patterns.some((re) => re.test(path)));
}

/** Runs the task gate in the build worktree. */
export async function runTaskGate(options: TaskGateOptions): Promise<TaskGateResult> {
  const { worktree } = options;
  const outside = outsideWritable(await worktree.changedSince(options.base), options.writable);
  const permission = { passed: outside.length === 0, writable: [...options.writable], outside };
  const lock = options.lock ? await checkLock(worktree, options.lock) : undefined;
  const before = new Set(await worktree.untracked());
  const commands: TaskGateCommand[] = [];
  const run = { repoPath: worktree.path, shell: options.shell, signal: options.signal };
  const timed = options.timeoutMs === undefined ? run : { ...run, timeoutMs: options.timeoutMs };
  const baseline = options.baseline ?? emptyBaseline();
  const earlier = options.earlier ?? [];
  const pending = options.pending ?? [];
  const protect = [...(options.protect ?? []), ...earlier.flatMap((t) => t.tests)];
  const lockOwners = earlierLockCommands(options.lock, earlier);
  const deferred: string[] = [];
  const aside = await setAside(worktree.path, pending, protect);
  try {
    for (const cmd of options.commands.test) {
      if (options.signal?.aborted) break;
      if (names(cmd.command, pending) && !names(cmd.command, protect)) {
        deferred.push(cmd.command);
        continue;
      }
      commands.push(await runTestCommand(cmd, timed, baseline, protect));
    }
    // The tests that earlier tasks made pass, each by its own command, unless
    // a plan test command is the same command.
    const ran = new Set(commands.map((c) => commandKey(c)));
    for (const [key, { cmd }] of lockOwners) {
      if (options.signal?.aborted || ran.has(key)) continue;
      commands.push(await runTestCommand(cmd, timed, baseline, protect));
    }
  } finally {
    await aside.restore();
  }
  for (const kind of ["typecheck", "lint"] as const) {
    for (const cmd of options.commands[kind]) {
      if (options.signal?.aborted) break;
      commands.push(await runGateCommand(kind, cmd, timed));
    }
  }
  const regressions = findRegressions(commands, earlier, lockOwners);
  const leftovers = (await worktree.untracked()).filter((path) => !before.has(path));
  await worktree.remove(leftovers);
  const quarantined = commands.flatMap((c) =>
    (c.quarantined ?? []).map((failure) => ({ command: c.command, cwd: c.cwd, failure })),
  );
  return {
    passed: permission.passed && (lock?.passed ?? true) && commands.every((c) => c.passed),
    permission,
    ...(lock ? { lock } : {}),
    commands,
    leftovers,
    ...(quarantined.length > 0 ? { quarantined } : {}),
    ...(regressions.length > 0 ? { regressions } : {}),
    ...(deferred.length > 0 ? { deferred } : {}),
    ...(aside.paths.length > 0 ? { setAside: aside.paths } : {}),
  };
}

/** One line that says why the gate failed. */
export function gateFailureLine(result: TaskGateResult): string {
  const parts: string[] = [];
  if (!result.permission.passed) {
    parts.push(`changed files outside the writable paths: ${result.permission.outside.join(", ")}`);
  }
  if (result.lock && !result.lock.passed) {
    parts.push(`changed locked tests: ${result.lock.changed.join(", ")}`);
  }
  if (result.regressions?.length) {
    parts.push(
      `broke tests that earlier tasks made pass: ${result.regressions.map((r) => `${r.test} (${r.taskId})`).join(", ")}`,
    );
  }
  for (const c of result.commands.filter((c) => !c.passed)) {
    parts.push(
      `${c.kind} command \`${c.command}\` ${c.timedOut ? "timed out" : `exited ${c.exitCode}`}`,
    );
  }
  return parts.join("; ") || "the gate passed";
}

/** The gate's failures in full, for the next attempt's prompt. */
export function gateReport(result: TaskGateResult): string {
  const parts: string[] = [];
  if (!result.permission.passed) {
    parts.push(
      [
        "Permission check: these changed files are outside the paths you may change, so the engine reset the worktree to the attempt's start:",
        ...result.permission.outside.map((p) => `  ${p}`),
      ].join("\n"),
    );
  }
  if (result.lock && !result.lock.passed) {
    parts.push(
      [
        "Test lock: you changed these locked tests, so the engine put them back. Don't change a locked test; when you believe one is wrong, send a test dispute with your reason.",
        ...result.lock.changed.map((p) => `  ${p}`),
      ].join("\n"),
    );
  }
  if (result.regressions?.length) {
    parts.push(
      [
        "Regression: these tests passed when an earlier task finished, and they fail now. Make them pass again without changing them; breaking them again escalates the task.",
        ...result.regressions.map((r) => `  ${r.test} (task ${r.taskId})`),
      ].join("\n"),
    );
  }
  for (const c of result.commands.filter((c) => !c.passed)) {
    parts.push(
      [
        `${c.kind} command: ${c.command} (${c.timedOut ? "timed out" : `exit ${c.exitCode}`})`,
        `Output tail:\n${c.outputTail}`,
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}
