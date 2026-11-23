// The failure fingerprint: the failing checks of one task gate run, each
// with its first error line after the engine strips line numbers, paths,
// addresses, and timestamps. Two gate failures in a row with one
// fingerprint mean the Developer is stuck on the same problem, and the
// engine seats the Debugger.
//
// Lines that the baseline excuses (known failing and flaky tests) and lines
// that the gate quarantined don't feed a fingerprint: they say nothing about
// the attempt.
import { extractFailures, isCountLine } from "../gate/gate.js";
import { emptyBaseline, excusedFailures, type TestBaseline } from "./baseline.js";
import type { TaskGateCommand, TaskGateResult } from "./gate.js";

/** A gate run's failure fingerprint: one sorted entry for each failing check. */
export type FailureFingerprint = string[];

export interface FingerprintOptions {
  /** The build's known failing and flaky tests. Absent means none. */
  baseline?: TestBaseline;
  /** The task's own test files: a baseline line that names one still counts. */
  protect?: readonly string[];
}

const TIMESTAMP_RE =
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g;
const ADDRESS_RE = /\b0x[0-9a-f]*/gi;
// A path with at least one separator, with an optional `file://` scheme and
// a trailing `:LINE`, `:LINE:COLUMN`, or `(LINE,COLUMN)`.
const PATH_RE =
  /(?:[a-z][\w+.-]*:\/\/)?(?:[A-Za-z]:)?(?:[\w.@~+-]*[\\/])+[\w.@+-]*(?:(?::\d+){1,2}|\(\d+,\d+\))?/g;
// A file name's line and column: `cart.mjs:3:8`, or TypeScript's `cart.ts(3,8)`.
const FILE_LINE_RE = /(\.[A-Za-z]\w*)(?::\d+(?::\d+)?|\(\d+,\d+\))/g;
const LINE_WORD_RE = /\bline \d+/gi;

/**
 * An error line without what changes between two runs of one failure: line
 * numbers, paths, addresses, and timestamps.
 */
export function normalizeErrorLine(line: string): string {
  return line
    .replace(TIMESTAMP_RE, "<time>")
    .replace(ADDRESS_RE, "<address>")
    .replace(PATH_RE, "<path>")
    .replace(FILE_LINE_RE, "$1")
    .replace(LINE_WORD_RE, "line <n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** The lines of a command's run that don't feed a fingerprint. */
function ignoredLines(c: TaskGateCommand, options: FingerprintOptions): Set<string> {
  if (c.kind !== "test") return new Set();
  const protect = options.protect ?? [];
  const ignored = new Set([
    ...excusedFailures(options.baseline ?? emptyBaseline(), c),
    ...(c.quarantined ?? []),
  ]);
  for (const line of ignored) {
    if (protect.some((path) => line.includes(path))) ignored.delete(line);
  }
  return ignored;
}

/**
 * The first error line of a failing command: the first failure line of its
 * output tail in output order, then any other failure line, then its exit.
 */
function firstErrorLine(c: TaskGateCommand, options: FingerprintOptions): string {
  const ignored = ignoredLines(c, options);
  const inOrder = c.outputTail.split("\n").flatMap((line) => extractFailures(line));
  const line = [...inOrder, ...c.failures].find((l) => !isCountLine(l) && !ignored.has(l));
  if (line !== undefined) {
    const normalized = normalizeErrorLine(line);
    if (normalized !== "") return normalized;
  }
  return c.timedOut ? "timed out" : `exit ${c.exitCode}`;
}

/** The failure fingerprint of a task gate run. Empty when the gate passed. */
export function failureFingerprint(
  gate: TaskGateResult,
  options: FingerprintOptions = {},
): FailureFingerprint {
  const entries: string[] = [];
  if (!gate.permission.passed) entries.push("permission: changed files outside the writable paths");
  if (gate.lock && !gate.lock.passed) entries.push("test lock: changed locked tests");
  for (const c of gate.commands.filter((c) => !c.passed)) {
    const where = c.cwd ? ` in ${c.cwd}` : "";
    entries.push(`${c.kind} \`${c.command}\`${where}: ${firstErrorLine(c, options)}`);
  }
  return entries.sort();
}

/** True when two fingerprints name the same failures; an empty one matches nothing. */
export function sameFingerprint(a: FailureFingerprint, b: FailureFingerprint): boolean {
  return a.length > 0 && a.length === b.length && a.every((entry, i) => entry === b[i]);
}
