// The test and lint gate (design.md, pre-push steps 1 and 7): a baseline at
// preflight, a rerun after each fix, and regression detection against the
// baseline.
import { join } from "node:path";
import type { PolicyCommand, PolicyFile } from "@agentbox/contracts";
import type { CommandRunner } from "../core.js";

export interface GateCommandResult {
  kind: "test" | "lint";
  command: string;
  cwd: string | null;
  exitCode: number;
  passed: boolean;
  timedOut: boolean;
  /** Normalized failure lines, for comparing two runs of a failing command. */
  failures: string[];
  /** The last lines of the output, for reports and the fixer prompt. */
  outputTail: string;
}

export interface GateRun {
  passed: boolean;
  commands: GateCommandResult[];
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

/** Failure lines from a command's output, with timings, addresses, and colors removed. */
export function extractFailures(output: string): string[] {
  const seen = new Set<string>();
  for (const raw of output.replace(ANSI_RE, "").split("\n")) {
    if (!FAILURE_RE.test(raw)) continue;
    const line = raw
      .replace(/\(?\b\d+(\.\d+)?\s?(ms|s|sec|seconds)\b\)?/g, "")
      .replace(/0x[0-9a-f]+/gi, "0x")
      .replace(/\s+/g, " ")
      .trim();
    if (line) seen.add(line);
  }
  return [...seen].sort();
}

function tail(text: string, lines = 40): string {
  return text.replace(ANSI_RE, "").trimEnd().split("\n").slice(-lines).join("\n");
}

export interface GateOptions {
  repoPath: string;
  shell: CommandRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function runOne(
  kind: "test" | "lint",
  cmd: PolicyCommand,
  options: GateOptions,
): Promise<GateCommandResult> {
  const result = await options.shell.run(cmd.command, [], {
    cwd: cmd.cwd ? join(options.repoPath, cmd.cwd) : options.repoPath,
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    signal: options.signal,
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
  };
}

/** Runs every test and lint command of the policy, in order. */
export async function runGate(policy: PolicyFile, options: GateOptions): Promise<GateRun> {
  const commands: GateCommandResult[] = [];
  for (const cmd of policy.tests) commands.push(await runOne("test", cmd, options));
  for (const cmd of policy.lint) commands.push(await runOne("lint", cmd, options));
  return { passed: commands.every((c) => c.passed), commands };
}

function key(c: Pick<GateCommandResult, "kind" | "command" | "cwd">): string {
  return `${c.kind}\0${c.command}\0${c.cwd ?? ""}`;
}

/**
 * Compares a gate run with the baseline. A command that passed and now
 * fails is a regression; so is a command that failed at the baseline and
 * now fails with new failure lines. Failures the baseline already had are not.
 */
export function compareGate(baseline: GateRun, current: GateRun): GateComparison {
  const before = new Map(baseline.commands.map((c) => [key(c), c]));
  const regressions: Regression[] = [];
  for (const c of current.commands) {
    if (c.passed) continue;
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
    const known = new Set(b.failures);
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
