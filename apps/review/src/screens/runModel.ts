// Pure helpers for the run view: the stage stepper, the decision panel, and
// which controls a run's status allows.
import type {
  Decision,
  DecisionOption,
  Finding,
  Pipeline,
  RunState,
  RunStatus,
  Stage,
} from "@agentbox/contracts";

/** The steps each pipeline shows, in order. `sweep` follows verify, as in the design. */
export const PIPELINE_STEPS: Record<Pipeline, readonly Stage[]> = {
  "pre-push": ["preflight", "group", "find", "merge", "verify", "sweep", "fix", "gate", "confirm", "done"],
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
    explanation: "A finding that an earlier fix closed was raised again. Compare both versions before you go on.",
  },
  round_cap: {
    title: "The run reached its round cap",
    explanation: "The pipeline stopped at the round limit with findings still open.",
  },
  ceiling: {
    title: "A vendor passed its usage ceiling",
    explanation: "The fixer can't continue until the usage window resets or you raise the ceiling.",
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
export function oscillationPairs(findings: readonly Finding[]): Array<{ before: Finding; after: Finding }> {
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
  push: boolean;
  /** Profile and role changes apply from the next round. */
  steer: boolean;
}

/** Which controls a run allows in its current state. */
export function runControls(run: RunState): Controls {
  const active = run.status === "running" || run.status === "pending" || run.status === "paused" || run.status === "waiting_decision";
  return {
    pause: run.status === "running" || run.status === "pending",
    resume: run.status === "paused",
    cancel: active,
    rebaseBase: active,
    push:
      run.request.pipeline === "pre-push" &&
      !run.request.readOnly &&
      run.status === "finished" &&
      run.stopReason === "clean" &&
      !run.prUrl,
    steer: active,
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
