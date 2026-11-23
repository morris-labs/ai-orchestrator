// The task gate: the checks that decide whether a Developer attempt counts.
// It compares the task's changes with the role's writable paths, then runs
// the plan's test, type check, and lint commands in the build worktree.
//
// When tests first locked the tests, the gate also checks the test lock.
//
// Later milestones add checks here: the tests that earlier tasks made pass,
// a rerun of a failing test for flakiness, and the failure fingerprint.
import type { BuildCommands } from "@aio/contracts";
import type { CommandRunner } from "../core.js";
import { runGateCommand, type GateCommandResult } from "../gate/gate.js";
import { globToRegExp } from "../policy/glob.js";
import { checkLock, type LockCheck, type TestLock } from "./test-lock.js";
import type { BuildWorktree } from "./worktree.js";

/** The permission check: the changed paths that no writable glob covers. */
export interface PermissionCheck {
  passed: boolean;
  writable: string[];
  outside: string[];
}

export interface TaskGateResult {
  passed: boolean;
  permission: PermissionCheck;
  /** The test lock check, when the build has a test lock. */
  lock?: LockCheck;
  commands: GateCommandResult[];
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
  /** The build's test lock; the gate fails an attempt that changes a locked file. */
  lock?: TestLock | null;
  /** Runs one command line through a shell. */
  shell: CommandRunner;
  signal?: AbortSignal;
  timeoutMs?: number;
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
  const commands: GateCommandResult[] = [];
  const run = { repoPath: worktree.path, shell: options.shell, signal: options.signal };
  const timed = options.timeoutMs === undefined ? run : { ...run, timeoutMs: options.timeoutMs };
  for (const kind of ["test", "typecheck", "lint"] as const) {
    for (const cmd of options.commands[kind]) {
      if (options.signal?.aborted) break;
      commands.push(await runGateCommand(kind, cmd, timed));
    }
  }
  const leftovers = (await worktree.untracked()).filter((path) => !before.has(path));
  await worktree.remove(leftovers);
  return {
    passed: permission.passed && (lock?.passed ?? true) && commands.every((c) => c.passed),
    permission,
    ...(lock ? { lock } : {}),
    commands,
    leftovers,
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
