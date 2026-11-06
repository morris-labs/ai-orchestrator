// Keeps a run's task list: one entry per agent call, in pipeline order.
import type { AgentRole, RunTask, RunTaskState, Stage } from "./runs.js";

/** The order stages run in within a round, for sorting tasks. */
const STAGE_ORDER: readonly Stage[] = [
  "preflight",
  "group",
  "push",
  "poll",
  "import",
  "find",
  "merge",
  "verify",
  "sweep",
  "fix",
  "gate",
  "confirm",
  "done",
];

/** A call the engine plans or starts. */
export interface TaskInput {
  key: string;
  round: number;
  stage: Stage;
  role: AgentRole;
  groupId: string | null;
  label: string;
  vendor?: RunTask["vendor"];
  effort?: string | undefined;
}

/** Tasks sorted by round, then stage, then the order the engine added them. */
export function sortTasks(tasks: readonly RunTask[]): RunTask[] {
  return [...tasks].sort(
    (a, b) =>
      a.round - b.round ||
      STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) ||
      a.seq - b.seq,
  );
}

function nextSeq(tasks: readonly RunTask[]): number {
  return tasks.reduce((n, t) => Math.max(n, t.seq + 1), 0);
}

/**
 * Adds planned calls as queued tasks. A task with the same round and key
 * keeps its state, and takes the new label, vendor, and effort only while
 * it's still queued.
 */
export function planTasks(tasks: readonly RunTask[], planned: readonly TaskInput[]): RunTask[] {
  const out = [...tasks];
  let seq = nextSeq(out);
  for (const p of planned) {
    const index = out.findIndex((t) => t.round === p.round && t.key === p.key);
    const existing = index >= 0 ? out[index] : undefined;
    if (existing) {
      if (existing.state === "queued") out[index] = { ...existing, ...withoutUndefined(p) };
      continue;
    }
    out.push({ ...withoutUndefined(p), state: "queued", seq: seq++ });
  }
  return sortTasks(out);
}

/**
 * Sets a task's state, adding the task when nothing planned it. The engine
 * calls this when a call starts and when it ends.
 */
export function markTask(
  tasks: readonly RunTask[],
  input: TaskInput,
  state: RunTaskState,
): RunTask[] {
  const out = [...tasks];
  const index = out.findIndex((t) => t.round === input.round && t.key === input.key);
  const existing = index >= 0 ? out[index] : undefined;
  if (existing) {
    // A started call knows its stage, vendor, and effort for sure.
    out[index] = { ...existing, ...withoutUndefined(input), label: existing.label, state };
  } else {
    out.push({ ...withoutUndefined(input), state, seq: nextSeq(out) });
  }
  return sortTasks(out);
}

/**
 * Marks the queued tasks of a stage skipped once the run moves past it: a
 * resumed or replanned stage can drop calls it once planned.
 */
export function skipQueued(tasks: readonly RunTask[], round: number, stage: Stage): RunTask[] {
  return tasks.map((t) =>
    t.round === round && t.stage === stage && t.state === "queued"
      ? { ...t, state: "skipped" as const }
      : t,
  );
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

const ROLE_LABELS: Record<AgentRole, string> = {
  reviewer: "Review",
  disprover: "Verify",
  confirmer: "Confirm fixes",
  fixer: "Fix",
  sweeper: "Sweep",
};

/**
 * A short label for a call from its role and cache key, such as
 * `Review G03` or `Verify F-0012`.
 */
export function taskLabel(role: AgentRole, key: string, groupId: string | null): string {
  const base = ROLE_LABELS[role];
  const finding = /F-\d+/.exec(key)?.[0];
  if (role === "disprover" && finding) return `${base} ${finding}`;
  const extra = /-(ledger|more)(\d+)$/.exec(key);
  const follow = extra
    ? ` (${extra[1] === "ledger" ? "coverage" : "more"} follow-up ${extra[2]})`
    : "";
  if (groupId) return `${base} ${groupId}${follow}`;
  if (role === "reviewer") return `${base} whole diff${follow}`;
  return base;
}

/** The effort each stage's calls ask for, for a person to read before a run starts. */
export interface StageEffort {
  stage: string;
  effort: string;
}

/**
 * The effort each stage uses. Reviewers take the run's reviewer effort; the
 * other stages have fixed settings in the engine. Copilot ignores effort.
 */
export function stageEfforts(reviewerEffort: string | undefined): StageEffort[] {
  return [
    { stage: "Review", effort: reviewerEffort ?? "each vendor's default" },
    {
      stage: "Verification",
      effort:
        "each vendor's default for one finding, medium for a batch, high for a batch of 5 or more",
    },
    { stage: "Triage below the floor", effort: "medium" },
    { stage: "Sweep, fixing, and confirming", effort: "each vendor's default" },
  ];
}
