// The preflight step: before the first task, the engine checks that the
// project gives the build every secret its plan lists, and that the build
// plan's test, type check, and lint commands run, then records the test
// baseline from three runs of the test commands.
//
// The step saves each finished run in `preflight.json` and the baseline in
// `baseline.json`. A restarted build continues from the saved runs; a build
// with a baseline skips the step. A command that can't run escalates, and
// the step saves nothing for it, so it checks every command again once the
// plan or the worktree is fixed.
import type { BuildCommands, PolicyCommand } from "@aio/contracts";
import { RunCancelled, describeError } from "../../calls/index.js";
import { runGateCommand, type GateCommandKind, type GateCommandResult } from "../../gate/gate.js";
import { BASELINE_FILE, baselineChecks, classifyRuns, couldNotRun } from "../baseline.js";
import type { BuildContext } from "../context.js";
import type { StepOutcome } from "./types.js";

/** Runs of the test commands that the baseline compares. */
export const PREFLIGHT_RUNS = 3;

/** The preflight file, `preflight.json`: the results so far. */
export interface PreflightRecord {
  /** The type check and lint commands, run once each. */
  checks: GateCommandResult[];
  /** One result per test command for each finished run. */
  runs: GateCommandResult[][];
}

const PREFLIGHT_FILE = "preflight.json";

/** Runs `commands` of each kind in the build worktree and deletes the untracked files they left. */
async function runCommands(
  ctx: BuildContext,
  commands: readonly { kind: GateCommandKind; cmd: PolicyCommand }[],
): Promise<GateCommandResult[]> {
  const signal = ctx.signal;
  const before = new Set(await ctx.worktree.untracked());
  const results: GateCommandResult[] = [];
  for (const { kind, cmd } of commands) {
    if (signal.aborted) break;
    results.push(
      await runGateCommand(kind, cmd, {
        repoPath: ctx.worktree.path,
        shell: ctx.services.shell,
        signal,
        diagnostics: kind !== "test",
      }),
    );
  }
  const leftovers = (await ctx.worktree.untracked()).filter((path) => !before.has(path));
  await ctx.worktree.remove(leftovers);
  // Results of commands that the engine stopped part way say nothing.
  if (signal.aborted) throw new RunCancelled();
  return results;
}

function ofKind(commands: BuildCommands, ...kinds: GateCommandKind[]) {
  return kinds.flatMap((kind) => commands[kind].map((cmd) => ({ kind, cmd })));
}

/** Escalates the commands that couldn't run. */
async function escalateUnrunnable(
  ctx: BuildContext,
  failed: readonly GateCommandResult[],
): Promise<StepOutcome> {
  const names = failed.map((c) => `${c.kind} command \`${c.command}\``);
  await ctx.escalate({
    kind: "preflight",
    level: "project_manager",
    taskId: null,
    summary: `Preflight: the plan's ${names.join(", ")} can't run.`,
    details: failed
      .map((c) =>
        [
          `${c.kind} command: ${c.command}${c.cwd ? ` (in ${c.cwd})` : ""}, exit ${c.exitCode}`,
          `Output tail:\n${c.outputTail}`,
        ].join("\n"),
      )
      .join("\n\n"),
  });
  return "wait";
}

/**
 * Escalates to the owner when the project doesn't give the build a secret
 * that its plan lists. Returns `null` when every secret is there, or when
 * the engine can't list them.
 */
async function checkSecrets(ctx: BuildContext): Promise<StepOutcome | null> {
  const wanted = ctx.plan.secrets;
  const list = ctx.services.secretNames;
  if (wanted.length === 0 || !list) return null;
  let names: string[];
  try {
    names = await list();
  } catch (error) {
    await ctx.escalate({
      kind: "missing_secret",
      level: "owner",
      taskId: null,
      summary: "Preflight can't list the project's secrets, which the build plan needs.",
      details: `Secrets the plan lists: ${wanted.map((s) => s.name).join(", ")}.\n\nThe secrets broker answered: ${describeError(error)}`,
    });
    return "wait";
  }
  const missing = wanted.filter((s) => !names.includes(s.name));
  if (missing.length === 0) return null;
  await ctx.escalate({
    kind: "missing_secret",
    level: "owner",
    taskId: null,
    summary: `The project doesn't give the build the secret${missing.length === 1 ? "" : "s"} ${missing.map((s) => s.name).join(", ")}.`,
    details: [
      "The build plan lists these secrets, and the project's secrets don't include them:",
      ...missing.map((s) => `- ${s.name}: ${s.purpose}`),
      "",
      "Tick each one for the project in the box's Secrets (project) section, then resolve the escalation with a retry.",
    ].join("\n"),
  });
  return "wait";
}

/** The preflight step. */
export async function runPreflight(ctx: BuildContext): Promise<StepOutcome> {
  const { store } = ctx;
  if (await store.readJson(store.path(BASELINE_FILE))) return "next";
  const secrets = await checkSecrets(ctx);
  if (secrets) return secrets;
  const path = store.path(PREFLIGHT_FILE);
  let record = await store.readJson<PreflightRecord>(path);
  if (!record) {
    // The first test run doubles as the test commands' check.
    const checks = await runCommands(ctx, ofKind(ctx.plan.commands, "typecheck", "lint"));
    const first = await runCommands(ctx, ofKind(ctx.plan.commands, "test"));
    const failed = [...first, ...checks].filter(couldNotRun);
    if (failed.length > 0) return escalateUnrunnable(ctx, failed);
    record = { checks, runs: [first] };
    await store.writeJson(path, record);
  }
  while (record.runs.length < PREFLIGHT_RUNS) {
    await ctx.calls.checkpoint();
    record.runs.push(await runCommands(ctx, ofKind(ctx.plan.commands, "test")));
    await store.writeJson(path, record);
  }
  const checks = baselineChecks(record.checks);
  await store.writeJson(store.path(BASELINE_FILE), {
    ...classifyRuns(record.runs),
    ...(checks.length > 0 ? { checks } : {}),
  });
  return "next";
}
