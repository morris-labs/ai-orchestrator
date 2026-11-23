// The task gate: the checks that decide whether a Developer attempt counts.
// It compares the task's changes with the role's writable paths, then runs
// the plan's test, type check, and lint commands in the build worktree.
//
// A failing test command runs once more. A test that fails and then passes
// is flaky: the gate quarantines it. A test command that fails only on known
// failing or flaky tests from the build's baseline doesn't fail the gate.
//
// Later milestones add checks here: the tests that earlier tasks made pass,
// the test lock, and the failure fingerprint.
import type { BuildCommands, PolicyCommand } from "@aio/contracts";
import type { CommandRunner } from "../core.js";
import { runGateCommand, type GateCommandResult, type GateOptions } from "../gate/gate.js";
import {
  emptyBaseline,
  excusedFailures,
  failsOnlyOnBaseline,
  testFailures,
  type TestBaseline,
} from "./baseline.js";
import { globToRegExp } from "../policy/glob.js";
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
  commands: TaskGateCommand[];
  /** Tests that failed and then passed in a rerun. The caller adds them to the baseline. */
  quarantined?: QuarantinedTest[];
  /** Untracked files the commands left, which the gate deleted. */
  leftovers: string[];
}

export interface TaskGateOptions {
  worktree: BuildWorktree;
  /** The commit the task started from; the permission check covers every change since. */
  base: string;
  /** Repository-relative globs that the seat may change. */
  writable: readonly string[];
  commands: BuildCommands;
  /** Runs one command line through a shell. */
  shell: CommandRunner;
  /** The build's known failing and flaky tests. Absent means none. */
  baseline?: TestBaseline;
  /** The task's own test files: a failure that names one is never excused. */
  protect?: readonly string[];
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
  const before = new Set(await worktree.untracked());
  const commands: TaskGateCommand[] = [];
  const run = { repoPath: worktree.path, shell: options.shell, signal: options.signal };
  const timed = options.timeoutMs === undefined ? run : { ...run, timeoutMs: options.timeoutMs };
  const baseline = options.baseline ?? emptyBaseline();
  for (const kind of ["test", "typecheck", "lint"] as const) {
    for (const cmd of options.commands[kind]) {
      if (options.signal?.aborted) break;
      commands.push(
        kind === "test"
          ? await runTestCommand(cmd, timed, baseline, options.protect ?? [])
          : await runGateCommand(kind, cmd, timed),
      );
    }
  }
  const leftovers = (await worktree.untracked()).filter((path) => !before.has(path));
  await worktree.remove(leftovers);
  const quarantined = commands.flatMap((c) =>
    (c.quarantined ?? []).map((failure) => ({ command: c.command, cwd: c.cwd, failure })),
  );
  return {
    passed: permission.passed && commands.every((c) => c.passed),
    permission,
    commands,
    leftovers,
    ...(quarantined.length > 0 ? { quarantined } : {}),
  };
}

/** One line that says why the gate failed. */
export function gateFailureLine(result: TaskGateResult): string {
  const parts: string[] = [];
  if (!result.permission.passed) {
    parts.push(`changed files outside the writable paths: ${result.permission.outside.join(", ")}`);
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
