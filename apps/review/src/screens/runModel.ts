// Pure helpers for the run view: the stage stepper, the decision panel, and
// which controls a run's status allows.
import type {
  Decision,
  DecisionOption,
  Finding,
  Pipeline,
  RunState,
  RunStatus,
  RunTask,
  Stage,
} from "@aio/contracts";

/** The steps each pipeline shows, in order. `sweep` follows verify, as in the design. */
export const PIPELINE_STEPS: Record<Pipeline, readonly Stage[]> = {
  "pre-push": [
    "preflight",
    "group",
    "find",
    "merge",
    "verify",
    "sweep",
    "fix",
    "gate",
    "confirm",
    "done",
  ],
  "post-push": ["preflight", "push", "poll", "import", "verify", "fix", "gate", "done"],
};

export type StepState = "done" | "current" | "todo" | "paused" | "blocked" | "failed";

export interface Step {
  stage: Stage;
  state: StepState;
}

/**
 * The stepper for a run. Steps before the current stage are done; the
 * current one shows whether the run moves, waits, or failed. A finished run
 * marks every step done. A stage outside the pipeline's list (such as a
 * pre-push run's `push`) marks nothing current.
 */
export function stepStates(pipeline: Pipeline, stage: Stage, status: RunStatus): Step[] {
  const steps = PIPELINE_STEPS[pipeline];
  const index = steps.indexOf(stage);
  let currentState: StepState = "current";
  if (status === "paused") currentState = "paused";
  else if (status === "waiting_decision") currentState = "blocked";
  else if (status === "failed" || status === "cancelled") currentState = "failed";
  return steps.map((s, i) => {
    if (status === "finished") return { stage: s, state: "done" };
    if (index < 0) return { stage: s, state: "todo" };
    if (i < index) return { stage: s, state: "done" };
    if (i === index) return { stage: s, state: s === "done" ? "done" : currentState };
    return { stage: s, state: "todo" };
  });
}

export interface DecisionButton {
  option: DecisionOption;
  label: string;
  /** True when the button needs a reason first. */
  needsReason: boolean;
}

export interface DecisionViewModel {
  title: string;
  explanation: string;
  buttons: DecisionButton[];
  /** Show the findings in pairs, before and after, for an oscillation. */
  compareVersions: boolean;
}

const DECISION_TEXT: Record<Decision["kind"], { title: string; explanation: string }> = {
  oscillation: {
    title: "A fixed finding came back",
    explanation:
      "A finding that an earlier fix closed was raised again. Compare both versions before you go on.",
  },
  round_cap: {
    title: "The run reached its round cap",
    explanation: "The pipeline stopped at the round limit with findings still open.",
  },
  ceiling: {
    title: "A vendor reached its limit",
    explanation:
      "A role can't continue on any usable vendor. Assign it to another vendor, or resume after the vendor's usage resets or you raise its ceiling.",
  },
  gate_failed: {
    title: "Tests or lint regressed",
    explanation: "The gate failed against the baseline after the fixes.",
  },
  push_blocked: {
    title: "The push was blocked",
    explanation: "The post-push loop can't push the branch without your decision.",
  },
};

const BUTTONS: Record<DecisionOption, Omit<DecisionButton, "option">> = {
  resume: { label: "Resume", needsReason: false },
  resume_waive: { label: "Resume and waive these findings", needsReason: true },
  cancel: { label: "Cancel the run", needsReason: false },
};

export function decisionView(decision: Decision): DecisionViewModel {
  const text = DECISION_TEXT[decision.kind];
  const order: DecisionOption[] = ["resume", "resume_waive", "cancel"];
  return {
    title: text.title,
    explanation: text.explanation,
    buttons: order
      .filter((o) => decision.options.includes(o))
      .filter((o) => o !== "resume_waive" || decision.findingIds.length > 0)
      .map((option) => ({ option, ...BUTTONS[option] })),
    compareVersions: decision.kind === "oscillation",
  };
}

/**
 * Pairs the findings of an oscillation: for each fingerprint, the version a
 * fix closed (verdict `fixed`, or the earliest) and the version that came
 * back (the latest). A fingerprint with one finding pairs it with itself,
 * using its history as the earlier version.
 */
export function oscillationPairs(
  findings: readonly Finding[],
): Array<{ before: Finding; after: Finding }> {
  const byPrint = new Map<string, Finding[]>();
  for (const f of findings) byPrint.set(f.fingerprint, [...(byPrint.get(f.fingerprint) ?? []), f]);
  const pairs: Array<{ before: Finding; after: Finding }> = [];
  for (const group of byPrint.values()) {
    const sorted = [...group].sort((a, b) => a.round - b.round || a.id.localeCompare(b.id));
    const before = sorted.find((f) => f.verdict === "fixed") ?? sorted[0]!;
    const after = sorted[sorted.length - 1]!;
    pairs.push({ before, after });
  }
  return pairs;
}

export interface Controls {
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  rebaseBase: boolean;
  /** Resume a failed run from its saved state. */
  retry: boolean;
  push: boolean;
  /** A profile change applies from the next round, and a role change to calls not yet started. */
  steer: boolean;
}

/**
 * Reports whether `next` may replace `prev`: it's a different run, or it
 * isn't older by `updatedAt`. A REST response that started before an event
 * can arrive after it, and must not roll the run back.
 */
export function isNewerRun(prev: RunState | null, next: RunState): boolean {
  if (!prev || prev.id !== next.id) return true;
  return Date.parse(next.updatedAt) >= Date.parse(prev.updatedAt);
}

/** Which controls a run allows in its current state. */
export function runControls(run: RunState): Controls {
  const active =
    run.status === "running" ||
    run.status === "pending" ||
    run.status === "paused" ||
    run.status === "waiting_decision";
  return {
    pause: run.status === "running" || run.status === "pending",
    resume: run.status === "paused",
    cancel: active,
    rebaseBase: active,
    retry: run.status === "failed" && run.stage !== "done",
    push:
      run.request.pipeline === "pre-push" &&
      !run.request.readOnly &&
      run.status === "finished" &&
      (run.stopReason === "clean" ||
        run.stopReason === "clean_above_floor" ||
        run.stopReason === "clean_with_followups") &&
      !run.prUrl,
    // A retry can replace the vendor that a failed run stopped on.
    steer: active || run.status === "failed",
  };
}

/** A GitHub commit link from the run's pull request URL, or `null`. */
export function commitUrl(prUrl: string | undefined, sha: string): string | null {
  if (!prUrl) return null;
  const m = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/\d+/.exec(prUrl);
  return m ? `${m[1]}/commit/${sha}` : null;
}

/** The vendor behind a reviewer label such as `codex-gpt-5`, or `null`. */
export function vendorOfLabel(label: string): "claude" | "codex" | "copilot" | null {
  const head = label.toLowerCase().split(/[-_:/ ]/)[0];
  return head === "claude" || head === "codex" || head === "copilot" ? head : null;
}

/** The stages whose work is agent calls, so they appear in the task list. */
const CALL_STAGES: readonly Stage[] = ["find", "verify", "sweep", "fix", "confirm"];

const STAGE_LABELS: Partial<Record<Stage, string>> = {
  find: "Review",
  verify: "Verification",
  sweep: "Sweep",
  fix: "Fixing",
  confirm: "Confirm fixes",
};

/** One row of the run's task list: a task, or a stage that isn't planned yet. */
export interface TaskRow {
  key: string;
  round: number;
  stage: Stage;
  label: string;
  vendor: string | null;
  effort: string;
  state: RunTask["state"] | "planned later";
  /** The place in the queue, counting only work that hasn't started. */
  position: number | null;
}

/**
 * The full task list of a run: every task the engine planned or started, then
 * one row per remaining stage of the current round that has no tasks yet. A
 * task the engine adds later takes its place in pipeline order, and the
 * queue positions after it move down.
 */
export function taskRows(
  run: Pick<RunState, "tasks" | "stage" | "status" | "round" | "request">,
): TaskRow[] {
  const tasks = run.tasks ?? [];
  const rows: TaskRow[] = tasks.map((t) => ({
    key: `${t.round}/${t.key}`,
    round: t.round,
    stage: t.stage,
    label: t.label,
    vendor: t.vendor ?? null,
    effort: t.effort ?? "Default",
    state: t.state,
    position: null,
  }));
  const ended = ["finished", "failed", "cancelled"].includes(run.status);
  if (!ended && run.round > 0) {
    const steps = PIPELINE_STEPS[run.request.pipeline];
    const current = steps.indexOf(run.stage);
    const planned = new Set(tasks.filter((t) => t.round === run.round).map((t) => t.stage));
    for (const stage of steps.slice(Math.max(current, 0))) {
      if (!CALL_STAGES.includes(stage) || planned.has(stage)) continue;
      rows.push({
        key: `${run.round}/${stage}-later`,
        round: run.round,
        stage,
        label: `${STAGE_LABELS[stage] ?? stage}: the engine plans these calls when the stage starts`,
        vendor: null,
        effort: stage === "find" ? (run.request.reviewerEffort ?? "Default") : "Default",
        state: "planned later",
        position: null,
      });
    }
  }
  const order = (s: Stage) => {
    const i = PIPELINE_STEPS[run.request.pipeline].indexOf(s);
    return i < 0 ? CALL_STAGES.indexOf(s) : i;
  };
  // Stable: tasks keep the engine's order within a stage.
  const sorted = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.round - b.r.round || order(a.r.stage) - order(b.r.stage) || a.i - b.i)
    .map(({ r }) => r);
  let position = 0;
  return sorted.map((r) =>
    r.state === "queued" || r.state === "planned later" ? { ...r, position: ++position } : r,
  );
}

/** The run's progress over its known tasks, and its timing. */
export interface RunProgress {
  /** Finished, failed, and skipped tasks over every known task, from 0 to 1. */
  fraction: number;
  finished: number;
  total: number;
  elapsedMs: number;
  /**
   * The time the known tasks still need, or `null` until a task has finished.
   * It assumes as many calls at once as are running, and can't count stages
   * the engine hasn't planned yet.
   */
  remainingMs: number | null;
  /** True when stages planned later aren't in `remainingMs`. */
  moreLater: boolean;
}

export function runProgress(
  run: Pick<
    RunState,
    "tasks" | "stage" | "status" | "round" | "request" | "createdAt" | "finishedAt"
  >,
  now: number,
): RunProgress {
  const rows = taskRows(run);
  const tasks = run.tasks ?? [];
  const ended = (s: string) => s === "done" || s === "failed" || s === "skipped";
  const finished = tasks.filter((t) => ended(t.state)).length;
  const total = tasks.length;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const elapsedMs = Math.max(0, end - Date.parse(run.createdAt));
  const moreLater = rows.some((r) => r.state === "planned later");

  // The mean duration of finished calls per stage, and over every stage.
  const durations = new Map<Stage, number[]>();
  for (const t of tasks) {
    if (t.state !== "done" || !t.startedAt || !t.finishedAt) continue;
    const list = durations.get(t.stage) ?? [];
    list.push(Date.parse(t.finishedAt) - Date.parse(t.startedAt));
    durations.set(t.stage, list);
  }
  const all = [...durations.values()].flat();
  const mean = (xs: number[]) => xs.reduce((n, x) => n + x, 0) / xs.length;
  let remainingMs: number | null = null;
  if (all.length > 0 && !["finished", "failed", "cancelled"].includes(run.status)) {
    const overall = mean(all);
    let work = 0;
    let running = 0;
    for (const t of tasks) {
      const own = durations.get(t.stage);
      const expected = own?.length ? mean(own) : overall;
      if (t.state === "queued") work += expected;
      else if (t.state === "running") {
        running += 1;
        const spent = t.startedAt ? now - Date.parse(t.startedAt) : 0;
        work += Math.max(0, expected - spent);
      }
    }
    remainingMs = work / Math.max(1, running);
  } else if (["finished", "failed", "cancelled"].includes(run.status)) {
    remainingMs = 0;
  }
  return {
    fraction: total === 0 ? 0 : finished / total,
    finished,
    total,
    elapsedMs,
    remainingMs,
    moreLater,
  };
}
