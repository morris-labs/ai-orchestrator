// The Debugger: an on-call seat that the tasks step fills when the task gate
// fails two attempts in a row on one failure fingerprint. It reads the code
// and the gate output, changes nothing, and answers with a diagnosis that
// goes into the Developer's next attempt.
//
// Each diagnosis is a file, `tasks/TASK/diagnosis-N.json`, where N is the
// attempt after which the Debugger ran. A restarted build reads the file, and
// the call cache returns a finished call without calling again.
import type { BuildTask } from "@aio/contracts";
import { untrusted } from "../prompts/templates.js";
import type { BuildContext } from "./context.js";
import type { FailureFingerprint } from "./fingerprint.js";
import { gateReport, type TaskGateResult } from "./gate.js";
import type { RoleTask } from "./roles/index.js";

/** The seat that diagnoses a repeated failure. */
export const DEBUGGER = "debugger";

/** A Debugger diagnosis, as `tasks/TASK/diagnosis-N.json` saves it. */
export interface DiagnosisRecord {
  /** The attempt whose failure repeated the one before it. */
  attempt: number;
  /** The failure fingerprint that both attempts had. */
  fingerprint: FailureFingerprint;
  callKey: string;
  /** The Debugger's answer, once the call finished. */
  answer?: { vendor: string; model: string; output: Record<string, unknown> };
}

type Diagnosed = DiagnosisRecord & { answer: NonNullable<DiagnosisRecord["answer"]> };

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A diagnosis as text, for the Developer's prompt or the next Debugger's. */
export function diagnosisText(record: DiagnosisRecord): string {
  const output = record.answer?.output ?? {};
  const lines: string[] = [];
  for (const [label, key] of [
    ["Summary", "summary"],
    ["Cause", "cause"],
    ["Fix", "fix"],
  ] as const) {
    const value = text(output[key]);
    if (value) lines.push(`${label}: ${value}`);
  }
  const evidence = Array.isArray(output.evidence)
    ? output.evidence.flatMap((e) => text(e) ?? [])
    : [];
  if (evidence.length > 0) lines.push("Evidence:", ...evidence.map((e) => `- ${e}`));
  return lines.length > 0 ? lines.join("\n") : JSON.stringify(output, null, 2);
}

function debuggerContext(
  record: DiagnosisRecord,
  gate: TaskGateResult,
  earlier: DiagnosisRecord | undefined,
): string {
  const lines = [
    `The task gate failed the Developer's attempts ${record.attempt - 1} and ${record.attempt} with the same failure fingerprint, one line for each failing check:`,
    "",
    untrusted(record.fingerprint.join("\n")),
    "",
    "The task gate's report of the last attempt follows. The Developer's work from that attempt is in the worktree.",
    "",
    untrusted(gateReport(gate)),
  ];
  if (earlier?.answer) {
    lines.push(
      "",
      `An earlier diagnosis, after attempt ${earlier.attempt}, didn't fix the failure:`,
      "",
      untrusted(diagnosisText(earlier)),
    );
  }
  return lines.join("\n");
}

function roleTask(ctx: BuildContext, task: BuildTask, context: string): RoleTask {
  const criteria = new Map(ctx.plan.criteria.map((c) => [c.id, c.text]));
  return {
    id: task.id,
    title: task.title,
    description: `Diagnose why the task gate keeps failing the Developer's attempts at this task. The task: ${task.description}`,
    repoPath: ctx.worktree.path,
    branch: ctx.state.branch,
    ownedFiles: task.ownedFiles,
    contracts: task.contracts,
    criteria: task.criteria.map((id) => ({ id, text: criteria.get(id) ?? "" })),
    tests: task.tests,
    context,
  };
}

/** Reads the diagnosis made after `attempt`, when the Debugger made one. */
export async function readDiagnosis(
  ctx: BuildContext,
  taskId: string,
  attempt: number,
): Promise<DiagnosisRecord | undefined> {
  const record = await ctx.store.readJson<DiagnosisRecord>(
    ctx.store.diagnosisPath(taskId, attempt),
  );
  return record?.answer ? record : undefined;
}

/**
 * Seats the Debugger on the failure that attempt `attempt` repeated, and
 * returns its diagnosis. Returns the saved diagnosis when the call already
 * finished. Call errors reach the caller, which escalates them.
 */
export async function diagnose(
  ctx: BuildContext,
  task: BuildTask,
  attempt: number,
  fingerprint: FailureFingerprint,
  gate: TaskGateResult,
): Promise<Diagnosed> {
  const path = ctx.store.diagnosisPath(task.id, attempt);
  const saved = await ctx.store.readJson<DiagnosisRecord>(path);
  if (saved?.answer) return saved as Diagnosed;
  const record: DiagnosisRecord = saved ?? {
    attempt,
    fingerprint,
    callKey: `${task.id}-debug-${attempt}`,
  };
  if (!saved) await ctx.store.writeJson(path, record);
  const earlier = attempt > 2 ? await readDiagnosis(ctx, task.id, attempt - 1) : undefined;
  const outcome = await ctx.callSeat({
    seat: DEBUGGER,
    specialties: await ctx.specialties(task.specialties),
    key: record.callKey,
    step: "tasks",
    task: roleTask(ctx, task, debuggerContext(record, gate, earlier)),
  });
  const diagnosed: Diagnosed = {
    ...record,
    answer: { vendor: outcome.vendor, model: outcome.model, output: outcome.output },
  };
  await ctx.store.writeJson(path, diagnosed);
  return diagnosed;
}
