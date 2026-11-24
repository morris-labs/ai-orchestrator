// The preflight step: before the first task, the engine checks that the
// project gives the build every secret its plan lists, runs the build plan's
// setup commands to make the fresh worktree ready, checks that the plan's
// test, type check, and lint commands run, then records the test baseline
// from three runs of the test commands.
//
// Setup commands run in the test commands' environment (see
// `inTestEnvironment()`), so a dependency install picks the same Node.js as
// the tests. A plan without setup commands runs none; when the worktree has a
// lockfile, preflight warns the Project manager instead of guessing a package
// manager.
//
// The step saves each finished run in `preflight.json` and the baseline in
// `baseline.json`. A restarted build continues from the saved runs; a build
// with a baseline skips the step. A command that can't run escalates, and
// the step saves nothing for it, so it checks every command again once the
// plan or the worktree is fixed.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BuildCommands, PolicyCommand } from "@aio/contracts";
import { RunCancelled, describeError } from "../../calls/index.js";
import { runGateCommand, type GateCommandKind, type GateCommandResult } from "../../gate/gate.js";
import { BASELINE_FILE, baselineChecks, classifyRuns, couldNotRun } from "../baseline.js";
import type { BuildContext } from "../context.js";
import { inTestEnvironment } from "../test-command.js";
import type { StepOutcome } from "./types.js";

/** Runs of the test commands that the baseline compares. */
export const PREFLIGHT_RUNS = 3;

/** The preflight file, `preflight.json`: the results so far. */
export interface PreflightRecord {
  /** The setup commands as the engine ran them. Absent when the plan has none. */
  setup?: GateCommandResult[];
  /** What the Project manager must know about the setup, such as a lockfile without setup commands. */
  warnings?: string[];
  /** The type check and lint commands, run once each. */
  checks: GateCommandResult[];
  /** One result per test command for each finished run. */
  runs: GateCommandResult[][];
}

const PREFLIGHT_FILE = "preflight.json";

/**
 * Lockfiles whose dependencies a fresh worktree lacks until a command
 * installs them. Preflight looks for them at the worktree's root.
 */
export const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
];

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
        diagnostics: kind === "typecheck" || kind === "lint",
      }),
    );
  }
  const leftovers = (await ctx.worktree.untracked()).filter((path) => !before.has(path));
  await ctx.worktree.remove(leftovers);
  // Results of commands that the engine stopped part way say nothing.
  if (signal.aborted) throw new RunCancelled();
  return results;
}

/** The plan's setup commands, each in the test commands' environment and its own directory. */
function setupCommands(commands: BuildCommands) {
  return commands.setup.map((cmd) => ({
    kind: "setup" as const,
    cmd: { ...cmd, command: inTestEnvironment(cmd.command, commands) },
  }));
}

function noSetupWarning(lockfiles: readonly string[]): string {
  const files = lockfiles.map((name) => `\`${name}\``).join(", ");
  return `The worktree has ${files}, but the plan has no setup commands, so preflight installed no dependencies. Add the install command to the plan's setup commands and to the policy file's \`setup\` list.`;
}

/**
 * Runs the plan's setup commands. Returns their results and warnings, or
 * the outcome of the escalation when one fails: the other commands can't
 * run in a worktree whose setup failed.
 */
async function runSetup(
  ctx: BuildContext,
): Promise<{ setup: GateCommandResult[]; warnings: string[] } | StepOutcome> {
  const commands = ctx.plan.commands;
  if (commands.setup.length === 0) {
    const found = LOCKFILES.filter((name) => existsSync(join(ctx.worktree.path, name)));
    return { setup: [], warnings: found.length > 0 ? [noSetupWarning(found)] : [] };
  }
  const setup = await runCommands(ctx, setupCommands(commands));
  const failed = setup.filter((c) => !c.passed);
  if (failed.length > 0) {
    return escalateCommands(ctx, failed, "failed", [
      "Preflight runs the setup commands before every other command, in the environment of the plan's test commands. Fix the setup commands in the plan, or the worktree, then resolve this escalation with a retry.",
    ]);
  }
  return { setup, warnings: [] };
}

function ofKind(commands: BuildCommands, ...kinds: GateCommandKind[]) {
  return kinds.flatMap((kind) => commands[kind].map((cmd) => ({ kind, cmd })));
}

/** Escalates the commands that couldn't run or, for setup commands, failed. */
async function escalateCommands(
  ctx: BuildContext,
  failed: readonly GateCommandResult[],
  verb: "can't run" | "failed" = "can't run",
  notes: readonly string[] = [],
): Promise<StepOutcome> {
  const names = failed.map((c) => `${c.kind} command \`${c.command}\``);
  await ctx.escalate({
    kind: "preflight",
    level: "project_manager",
    taskId: null,
    summary: `Preflight: the plan's ${names.join(", ")} ${verb}.`,
    details: [
      ...failed.map((c) =>
        [
          `${c.kind} command: ${c.command}${c.cwd ? ` (in ${c.cwd})` : ""}, exit ${c.exitCode}${c.timedOut ? " (timed out)" : ""}`,
          `Output tail:\n${c.outputTail}`,
        ].join("\n"),
      ),
      ...notes,
    ].join("\n\n"),
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

/** Sends the setup warnings to the log and, as one digest item, to the Project manager's inbox. */
async function warnProjectManager(ctx: BuildContext, warnings: readonly string[]): Promise<void> {
  const [first] = warnings;
  if (first === undefined) return;
  for (const warning of warnings) {
    ctx.services.log.warn("Preflight found a setup problem", { build: ctx.state.slug, warning });
  }
  await ctx.toProjectManager({
    kind: "digest",
    ref: "preflight-setup",
    summary: first,
    file: PREFLIGHT_FILE,
    needsAnswer: false,
  });
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
    const ready = await runSetup(ctx);
    if (typeof ready === "string") return ready;
    // The first test run doubles as the test commands' check.
    const checks = await runCommands(ctx, ofKind(ctx.plan.commands, "typecheck", "lint"));
    const first = await runCommands(ctx, ofKind(ctx.plan.commands, "test"));
    const failed = [...first, ...checks].filter(couldNotRun);
    if (failed.length > 0) return escalateCommands(ctx, failed);
    record = {
      ...(ready.setup.length > 0 ? { setup: ready.setup } : {}),
      ...(ready.warnings.length > 0 ? { warnings: ready.warnings } : {}),
      checks,
      runs: [first],
    };
    await store.writeJson(path, record);
    await warnProjectManager(ctx, ready.warnings);
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
