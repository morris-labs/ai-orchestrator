// The red check: the engine's run of the Test engineer's tests before the
// code exists. Each test must fail on an assertion. A test that passes, or
// one that fails on a syntax, import, or setup error, goes back to the Test
// engineer, unless its criterion already holds, when passing is allowed.
//
// The engine runs each test with the command the Test engineer gives for it,
// in the environment of the plan's test commands (see `test-command.ts`), and
// reads the command's output to tell an assertion failure from an error.
import type { BuildCommands } from "@aio/contracts";
import type { CommandRunner } from "../core.js";
import { runGateCommand } from "../gate/gate.js";
import { listedTestCommand } from "./test-command.js";
import type { BuildWorktree } from "./worktree.js";

/**
 * How a test ended against the stubs: `failed` on an assertion (what the red
 * check wants), `passed`, or `error` (a syntax, import, or setup error, a
 * timeout, or output with no assertion failure in it).
 */
export type RedOutcome = "failed" | "passed" | "error";

/** One test, as the Test engineer lists it. */
export interface ListedTest {
  file: string;
  name: string;
  criterion: string;
  command: string;
}

/** One test's red check result. */
export interface RedTestResult extends ListedTest {
  outcome: RedOutcome;
  /** Why the outcome is what it is, in one line. */
  reason: string;
  exitCode: number | null;
  timedOut: boolean;
  /** The end of the command's output. */
  outputTail: string;
}

/** A round's red check: the problems that send the tests back, and each test's result. */
export interface RedCheck {
  passed: boolean;
  /** One line per problem; empty when the check passed. */
  problems: string[];
  tests: RedTestResult[];
}

/**
 * Output that shows a failure before any assertion ran: a syntax error, a
 * missing module or export, a name the stubs don't define, or a build or
 * type error, across the common JavaScript, TypeScript, Python, and Go tools.
 */
export const ERROR_PATTERNS: readonly RegExp[] = [
  /\bSyntaxError\b/,
  /\bIndentationError\b/,
  /\bReferenceError\b/,
  /\bNameError\b/,
  /\bTypeError\b.*\bis not a (?:function|constructor)\b/,
  /\bCannot find (?:module|package)\b/,
  /\bERR_MODULE_NOT_FOUND\b/,
  /\bModuleNotFoundError\b/,
  /\bImportError\b/,
  /\bFailed to (?:resolve import|load url)\b/,
  /\berror TS\d+\b/,
  /\[(?:build|setup) failed\]/,
];

/** Output that shows a failed assertion. */
export const ASSERTION_PATTERNS: readonly RegExp[] = [
  /\bAssertionError\b/,
  /\bassertion failed\b/i,
  /^\s*(?:Expected|Received|expected|actual):/m,
  /\bexpected\b.+\b(?:to|but)\b/i,
  /--- FAIL:/,
];

/** Classifies one finished test command. */
export function classifyRun(run: { exitCode: number | null; timedOut: boolean; output: string }): {
  outcome: RedOutcome;
  reason: string;
} {
  if (run.timedOut) return { outcome: "error", reason: "the test command timed out" };
  if (run.exitCode === 0) return { outcome: "passed", reason: "the test passed" };
  const error = ERROR_PATTERNS.find((re) => re.test(run.output));
  if (error) {
    const line =
      run.output
        .split("\n")
        .find((l) => error.test(l))
        ?.trim() ?? "";
    return { outcome: "error", reason: `the test failed on an error: ${line}` };
  }
  if (ASSERTION_PATTERNS.some((re) => re.test(run.output))) {
    return { outcome: "failed", reason: "the test failed on an assertion" };
  }
  return {
    outcome: "error",
    reason: `the test exited ${run.exitCode ?? "without a code"}, and its output shows no assertion failure`,
  };
}

export interface RunRedCheckOptions {
  worktree: BuildWorktree;
  tests: readonly ListedTest[];
  /** The plan's commands: each test runs with the leading assignments of its test commands. */
  commands: Pick<BuildCommands, "test">;
  /** The plan's criterion IDs that already hold: their tests may pass. */
  holds: ReadonlySet<string>;
  shell: CommandRunner;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Runs each test's command once in the worktree and checks each outcome.
 * Files that the commands create are deleted afterward.
 */
export async function runRedCheck(options: RunRedCheckOptions): Promise<RedCheck> {
  const { worktree } = options;
  const before = new Set(await worktree.untracked());
  const run = { repoPath: worktree.path, shell: options.shell, signal: options.signal };
  const timed = options.timeoutMs === undefined ? run : { ...run, timeoutMs: options.timeoutMs };
  const runs = new Map<string, Awaited<ReturnType<typeof runGateCommand>>>();
  const tests: RedTestResult[] = [];
  const problems: string[] = [];
  for (const test of options.tests) {
    if (options.signal?.aborted) break;
    let result = runs.get(test.command);
    if (!result) {
      result = await runGateCommand(
        "test",
        listedTestCommand(test.command, options.commands),
        timed,
      );
      runs.set(test.command, result);
    }
    const { outcome, reason } = classifyRun({
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      output: result.outputTail,
    });
    tests.push({
      ...test,
      outcome,
      reason,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      outputTail: result.outputTail,
    });
    const named = `Test "${test.name}" in ${test.file}`;
    if (outcome === "error") problems.push(`${named}: ${reason}.`);
    if (outcome === "passed" && !options.holds.has(test.criterion)) {
      problems.push(
        `${named} passes before the code exists, and criterion ${test.criterion} isn't one that already holds.`,
      );
    }
  }
  const leftovers = (await worktree.untracked()).filter((path) => !before.has(path));
  await worktree.remove(leftovers);
  return { passed: problems.length === 0, problems, tests };
}
