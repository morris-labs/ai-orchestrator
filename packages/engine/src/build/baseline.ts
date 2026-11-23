// The test baseline: the known failing and flaky tests of a build, in the
// build's `baseline.json` file. Preflight records it from three runs of the
// plan's test commands, and the task gate adds the tests it finds flaky.
//
// A test is a failure line of a test command (see `extractFailures()`),
// keyed by the command and its directory. Count lines, such as
// `Tests N failed`, name no test, so the baseline ignores them. A known
// failing or flaky test doesn't fail the task gate, except a test that names
// one of the task's own tests: the task exists to make those pass.
import type { PolicyCommand } from "@aio/contracts";
import { isCountLine, type GateCommandResult } from "../gate/gate.js";
import type { BuildStore } from "./store.js";

/** Where a flaky test showed: across the preflight runs, or in a task gate's rerun. */
export type FlakySource =
  | { at: "preflight" }
  | { at: "gate"; taskId: string; attempt: number };

/** The failing tests of one test command. */
export interface BaselineTests {
  command: string;
  cwd: string | null;
  failures: string[];
}

/** A quarantined test: its result differed between runs of the same code. */
export interface FlakyTest {
  command: string;
  cwd: string | null;
  failure: string;
  source: FlakySource;
}

/** The build's `baseline.json` file. */
export interface TestBaseline {
  version: 1;
  /** Tests that failed in every preflight run. */
  knownFailing: BaselineTests[];
  /** Quarantined tests, in the order the engine found them. */
  flaky: FlakyTest[];
}

/** The baseline file's name in the build directory. */
export const BASELINE_FILE = "baseline.json";

/** An empty baseline, for a build that started before preflight existed. */
export function emptyBaseline(): TestBaseline {
  return { version: 1, knownFailing: [], flaky: [] };
}

/** The key of a command in the baseline: its command line and directory. */
export function commandKey(c: { command: string; cwd?: string | null }): string {
  return `${c.command}\0${c.cwd ?? ""}`;
}

/** The test failure lines of a command's run, without count lines. Empty when it passed. */
export function testFailures(result: GateCommandResult): string[] {
  return result.passed ? [] : result.failures.filter((line) => !isCountLine(line));
}

/**
 * Classifies the preflight runs, each a result per test command: a failure
 * line in every run is known failing, and one in some runs only is flaky.
 */
export function classifyRuns(runs: readonly (readonly GateCommandResult[])[]): TestBaseline {
  const baseline = emptyBaseline();
  const byCommand = new Map<string, { command: string; cwd: string | null; runs: Set<string>[] }>();
  for (const run of runs) {
    for (const result of run) {
      const key = commandKey(result);
      let entry = byCommand.get(key);
      if (!entry) {
        entry = { command: result.command, cwd: result.cwd, runs: [] };
        byCommand.set(key, entry);
      }
      entry.runs.push(new Set(testFailures(result)));
    }
  }
  for (const { command, cwd, runs: seen } of byCommand.values()) {
    const all = [...new Set(seen.flatMap((lines) => [...lines]))].sort();
    const always = all.filter((line) => seen.every((lines) => lines.has(line)));
    if (always.length > 0) baseline.knownFailing.push({ command, cwd, failures: always });
    for (const failure of all.filter((line) => !always.includes(line))) {
      baseline.flaky.push({ command, cwd, failure, source: { at: "preflight" } });
    }
  }
  return baseline;
}

/** Reads the build's baseline; an empty one when the build has none. */
export async function loadBaseline(store: BuildStore): Promise<TestBaseline> {
  return (await store.readJson<TestBaseline>(store.path(BASELINE_FILE))) ?? emptyBaseline();
}

/** Adds quarantined tests to the build's baseline file. */
export async function quarantine(store: BuildStore, flaky: readonly FlakyTest[]): Promise<void> {
  if (flaky.length === 0) return;
  const baseline = await loadBaseline(store);
  baseline.flaky.push(...flaky);
  await store.writeJson(store.path(BASELINE_FILE), baseline);
}

/**
 * The baseline's tests of one command: the failure lines that don't fail
 * the gate. Lines that name one of `protect`, the task's own tests, never
 * count as excused.
 */
export function excusedFailures(
  baseline: TestBaseline,
  cmd: PolicyCommand | GateCommandResult,
): Set<string> {
  const key = commandKey(cmd);
  return new Set([
    ...baseline.knownFailing.filter((e) => commandKey(e) === key).flatMap((e) => e.failures),
    ...baseline.flaky.filter((e) => commandKey(e) === key).map((e) => e.failure),
  ]);
}

/**
 * True when a failing test command's run fails only on baseline tests. A
 * run that timed out, or that names no failing test, isn't excused: the
 * engine can't tell which test failed. Nor is a command or a failure line
 * that names one of `protect`, the task's own tests.
 */
export function failsOnlyOnBaseline(
  result: GateCommandResult,
  excused: ReadonlySet<string>,
  protect: readonly string[],
): boolean {
  if (result.passed || result.timedOut) return false;
  if (protect.some((path) => result.command.includes(path))) return false;
  const lines = testFailures(result);
  if (lines.length === 0) return false;
  return lines.every((line) => excused.has(line) && !protect.some((path) => line.includes(path)));
}

/** True when a command didn't start: the shell couldn't find or run it, or its directory is missing. */
export function couldNotRun(result: GateCommandResult): boolean {
  return result.exitCode === 126 || result.exitCode === 127;
}
