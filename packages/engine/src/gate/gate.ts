// The test and lint gate (design.md, pre-push steps 1 and 7): a baseline at
// preflight, a rerun after each fix, and regression detection against the
// baseline.
//
// The gate runs in the checkout under review, not in an engine checkout:
// test and lint commands need the dependencies and build caches that live
// there as ignored files. A person or the box's session can work in that
// checkout while the commands run, so the gate never deletes a file there.
// It reports the untracked files that appeared instead.
import { join } from "node:path";
import type { PolicyCommand, PolicyFile } from "@aio/contracts";
import type { CommandRunner } from "../core.js";

/** What a gate command checks. */
export type GateCommandKind = "test" | "typecheck" | "lint";

export interface GateCommandResult {
  kind: GateCommandKind;
  command: string;
  cwd: string | null;
  exitCode: number;
  passed: boolean;
  timedOut: boolean;
  /** True when a per-test command exited 0 but ran no tests, which fails it. */
  noTests?: boolean;
  /** Normalized failure lines, for comparing two runs of a failing command. */
  failures: string[];
  /** The last lines of the output, for reports and the fixer prompt. */
  outputTail: string;
  /**
   * Every diagnostic line of the output, normalized by `diagnosticLines()`,
   * when the caller asked for them with `GateOptions.diagnostics`.
   */
  diagnostics?: string[];
}

export interface GateRun {
  passed: boolean;
  commands: GateCommandResult[];
  /**
   * Untracked files that git doesn't ignore and that appeared while the
   * commands ran, such as build output. The gate leaves them in place: it
   * can't tell its commands' files from a person's. Absent when the gate
   * didn't check.
   */
  leftovers?: string[];
}

export interface Regression {
  command: string;
  reason: string;
  newFailures: string[];
  outputTail: string;
}

export interface GateComparison {
  regressed: boolean;
  regressions: Regression[];
}

const FAILURE_RE = /\b(FAIL(?:ED|URE)?|ERROR|Error|failed|AssertionError|Traceback|not ok)\b|✗|✖|×/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
// A runner's count line, such as vitest's `Tests  2 failed | 40 passed (42)`,
// jest's `Tests: 1 failed, 5 passed, 6 total`, or eslint's `3 problems`.
const COUNT_WORDS =
  "failed|failing|failures?|passed|passing|errors?|skipped|pending|todo|total|tests?|warnings?|problems?";
const SUMMARY_RE = new RegExp(`\\b\\d+\\s+(${COUNT_WORDS})\\b`, "i");
// A count line after `extractFailures()` replaced its numbers with `N`.
const COUNT_LINE_RE = new RegExp(`\\bN\\s+(${COUNT_WORDS})\\b`, "i");

/**
 * True for a failure line that only counts failures, such as
 * `Tests N failed | N passed`. A count line doesn't name a test, so the
 * test baseline ignores it.
 */
export function isCountLine(line: string): boolean {
  return COUNT_LINE_RE.test(line);
}

/**
 * Failure lines from a command's output, with timings, addresses, and colors
 * removed. Count lines keep their words but not their numbers, so a run with
 * fewer failures than the baseline doesn't look like it has a new failure;
 * per-test lines still tell the failures apart.
 */
export function extractFailures(output: string): string[] {
  const seen = new Set<string>();
  for (const raw of output.replace(ANSI_RE, "").split("\n")) {
    if (!FAILURE_RE.test(raw)) continue;
    let line = raw
      .replace(/\(?\b\d+(\.\d+)?\s?(ms|s|sec|seconds)\b\)?/g, "")
      .replace(/0x[0-9a-f]+/gi, "0x")
      .replace(/\s+/g, " ")
      .trim();
    if (SUMMARY_RE.test(line)) line = line.replace(/\d+/g, "N");
    if (line) seen.add(line);
  }
  return [...seen].sort();
}

/** The most diagnostic lines that `diagnosticLines()` keeps. */
export const DIAGNOSTIC_LINE_LIMIT = 5000;

/**
 * Every line of a type check or lint command's output, so a run can be
 * compared with an earlier run of the same command: colors, timings, and
 * addresses removed, line and column numbers replaced with `L:C`, and count
 * lines, such as `Found 3 errors`, left out. Unlike `extractFailures()`, it
 * keeps lines without a failure word, such as `error TS2322` or `1:1 error`.
 */
export function diagnosticLines(output: string): string[] {
  const seen = new Set<string>();
  for (const raw of output.replace(ANSI_RE, "").split("\n")) {
    let line = raw
      .replace(/\(?\b\d+(\.\d+)?\s?(ms|s|sec|seconds)\b\)?/g, "")
      .replace(/0x[0-9a-f]+/gi, "0x")
      .replace(/\(\d+,\d+\)/g, "(L,C)")
      .replace(/(^|[\s:])\d+:\d+(?=$|[\s:])/g, "$1L:C")
      .replace(/\s+/g, " ")
      .trim();
    if (!line) continue;
    if (SUMMARY_RE.test(line)) {
      line = line.replace(/\d+/g, "N");
      if (isCountLine(line)) continue;
    }
    seen.add(line);
    if (seen.size >= DIAGNOSTIC_LINE_LIMIT) break;
  }
  return [...seen].sort();
}

function tail(text: string, lines = 40): string {
  return text.replace(ANSI_RE, "").trimEnd().split("\n").slice(-lines).join("\n");
}

export interface GateOptions {
  repoPath: string;
  shell: CommandRunner;
  /**
   * Runs `git`. When present, the gate lists the untracked files that
   * appeared while its commands ran in `GateRun.leftovers`, so a report can
   * say why the tree is dirty afterwards. It never deletes them.
   */
  git?: CommandRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Adds every diagnostic line of the output to the result, as `diagnosticLines()` reads it. */
  diagnostics?: boolean;
}

/** Runs one gate command in `options.repoPath` and reports its result. */
export async function runGateCommand(
  kind: GateCommandKind,
  cmd: PolicyCommand,
  options: GateOptions,
): Promise<GateCommandResult> {
  const result = await options.shell.run(cmd.command, [], {
    cwd: cmd.cwd ? join(options.repoPath, cmd.cwd) : options.repoPath,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    signal: options.signal,
    env: GATE_ENV,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    kind,
    command: cmd.command,
    cwd: cmd.cwd ?? null,
    exitCode: result.exitCode,
    passed: result.exitCode === 0 && !result.timedOut,
    timedOut: result.timedOut,
    failures: extractFailures(output),
    outputTail: tail(output),
    ...(options.diagnostics ? { diagnostics: diagnosticLines(output) } : {}),
  };
}

/**
 * Environment for the gate's commands that keeps them from writing build
 * output into the tree: Python skips its `__pycache__` directories.
 */
export const GATE_ENV: Record<string, string> = { PYTHONDONTWRITEBYTECODE: "1" };

/**
 * Untracked files that git doesn't ignore, relative to the repository,
 * without the engine's own `.aio/` directory. `null` when git fails.
 */
export async function untrackedFiles(
  git: CommandRunner,
  repoPath: string,
): Promise<Set<string> | null> {
  const r = await git.run("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: repoPath,
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0) return null;
  return new Set(r.stdout.split("\0").filter((p) => p !== "" && !p.startsWith(".aio/")));
}

/**
 * Runs every test, type check, and lint command of the policy, in order. When
 * `options.git` is set, lists the untracked files that appeared meanwhile
 * in `leftovers`, without deleting any.
 */
export async function runGate(policy: PolicyFile, options: GateOptions): Promise<GateRun> {
  const before = options.git ? await untrackedFiles(options.git, options.repoPath) : null;
  const commands: GateCommandResult[] = [];
  for (const cmd of policy.tests) commands.push(await runGateCommand("test", cmd, options));
  for (const cmd of policy.typecheck ?? []) {
    commands.push(await runGateCommand("typecheck", cmd, options));
  }
  for (const cmd of policy.lint) commands.push(await runGateCommand("lint", cmd, options));
  const run: GateRun = { passed: commands.every((c) => c.passed), commands };
  if (options.git && before) {
    const after = await untrackedFiles(options.git, options.repoPath);
    if (after) run.leftovers = [...after].filter((path) => !before.has(path)).sort();
  }
  return run;
}

function key(c: Pick<GateCommandResult, "kind" | "command" | "cwd">): string {
  return `${c.kind}\0${c.command}\0${c.cwd ?? ""}`;
}

/** Failure lines of a test command that a gate comparison doesn't count, such as a build's flaky tests. */
export interface ExcusedFailures {
  command: string;
  cwd: string | null;
  failures: readonly string[];
}

/**
 * Compares a gate run with the baseline. A command that passed and now
 * fails is a regression; so is a command that failed at the baseline and
 * now fails with new failure lines. Failures the baseline already had are not,
 * nor are the `excused` failure lines of a test command. A test command that
 * fails only on excused lines isn't a regression, unless it timed out or
 * names no failing test.
 */
export function compareGate(
  baseline: GateRun,
  current: GateRun,
  excused: readonly ExcusedFailures[] = [],
): GateComparison {
  const before = new Map(baseline.commands.map((c) => [key(c), c]));
  const excusedLines = new Map<string, Set<string>>();
  for (const e of excused) {
    const k = key({ kind: "test", command: e.command, cwd: e.cwd });
    excusedLines.set(k, new Set([...(excusedLines.get(k) ?? []), ...e.failures]));
  }
  const regressions: Regression[] = [];
  for (const c of current.commands) {
    if (c.passed) continue;
    const allowed = excusedLines.get(key(c));
    if (allowed && !c.timedOut) {
      const lines = c.failures.filter((line) => !isCountLine(line));
      if (lines.length > 0 && lines.every((line) => allowed.has(line))) continue;
    }
    const b = before.get(key(c));
    if (!b || b.passed) {
      regressions.push({
        command: c.command,
        reason: c.timedOut ? "timed out" : `exits ${c.exitCode}; it passed at the baseline`,
        newFailures: c.failures,
        outputTail: c.outputTail,
      });
      continue;
    }
    const known = new Set([...b.failures, ...(allowed ?? [])]);
    const fresh = c.failures.filter((f) => !known.has(f));
    if (fresh.length > 0 || (c.timedOut && !b.timedOut)) {
      regressions.push({
        command: c.command,
        reason: c.timedOut ? "timed out" : "fails with failures the baseline didn't have",
        newFailures: fresh,
        outputTail: c.outputTail,
      });
    }
  }
  return { regressed: regressions.length > 0, regressions };
}

/** A report of the regressions for the fixer prompt. */
export function formatRegressions(comparison: GateComparison): string {
  return comparison.regressions
    .map((r) =>
      [
        `Command: ${r.command} (${r.reason})`,
        r.newFailures.length > 0
          ? `New failures:\n${r.newFailures.map((f) => `  ${f}`).join("\n")}`
          : "",
        `Output tail:\n${r.outputTail}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}
