import type { Decision, Finding, RunState } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import {
  PIPELINE_STEPS,
  commitUrl,
  decisionView,
  oscillationPairs,
  runControls,
  stepStates,
  vendorOfLabel,
} from "../src/screens/runModel.js";
import { demoFindings, lastRun } from "./helpers/data.js";

const states = (s: ReturnType<typeof stepStates>) => s.map((x) => x.state[0]).join("");

describe("stepStates", () => {
  // Letters: d done, c current, t todo, p paused, b blocked, f failed.
  it.each([
    ["pre-push", "preflight", "running", "cttttttttt"],
    ["pre-push", "verify", "running", "ddddcttttt"],
    ["pre-push", "merge", "waiting_decision", "dddbtttttt"],
    ["pre-push", "fix", "paused", "ddddddpttt"],
    ["pre-push", "gate", "failed", "dddddddftt"],
    ["pre-push", "confirm", "cancelled", "ddddddddft"],
    ["pre-push", "done", "finished", "dddddddddd"],
    ["pre-push", "push", "running", "tttttttttt"],
    ["post-push", "poll", "running", "ddcttttt"],
    ["post-push", "import", "waiting_decision", "dddbtttt"],
    ["post-push", "done", "running", "ddddddddd".slice(0, 8)],
  ] as const)("%s at %s while %s", (pipeline, stage, status, want) => {
    const steps = stepStates(pipeline, stage, status);
    expect(steps.map((s) => s.stage)).toEqual(PIPELINE_STEPS[pipeline]);
    expect(states(steps)).toBe(want);
  });
});

describe("decisionView", () => {
  const decision = (
    kind: Decision["kind"],
    options: Decision["options"],
    findingIds = ["F-0001"],
  ): Decision => ({
    kind,
    options,
    findingIds,
    message: "",
  });
  it.each([
    [
      decision("oscillation", ["resume", "resume_waive", "cancel"]),
      ["resume", "resume_waive", "cancel"],
      true,
      /came back/,
    ],
    [decision("round_cap", ["cancel", "resume"]), ["resume", "cancel"], false, /round cap/],
    [decision("ceiling", ["resume", "cancel"], []), ["resume", "cancel"], false, /limit/],
    [decision("gate_failed", ["resume_waive", "cancel"], []), ["cancel"], false, /regressed/],
    [decision("push_blocked", ["cancel"]), ["cancel"], false, /push was blocked/],
  ])("%#: %o", (d, buttons, compare, title) => {
    const v = decisionView(d);
    expect(v.buttons.map((b) => b.option)).toEqual(buttons);
    expect(v.compareVersions).toBe(compare);
    expect(v.title).toMatch(title);
    expect(v.buttons.find((b) => b.option === "resume_waive")?.needsReason ?? true).toBe(true);
  });
});

describe("oscillationPairs", () => {
  it("pairs the fixed version with the one that came back", () => {
    const all = demoFindings();
    const pairs = oscillationPairs(all.filter((f) => f.fingerprint === "fp-retry-loop"));
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.before.id).toBe("F-0001");
    expect(pairs[0]!.after.id).toBe("F-0007");
  });

  it("pairs a lone finding with itself", () => {
    const f = { id: "F-0009", fingerprint: "x", round: 1, verdict: "pending" } as Finding;
    expect(oscillationPairs([f])).toEqual([{ before: f, after: f }]);
  });
});

describe("runControls", () => {
  const base = lastRun();
  const with_ = (patch: Partial<RunState>) => runControls({ ...base, ...patch });
  it.each([
    [{ status: "running" }, { pause: true, resume: false, cancel: true, push: false, steer: true }],
    [{ status: "paused" }, { pause: false, resume: true, cancel: true, push: false, steer: true }],
    [
      { status: "waiting_decision" },
      { pause: false, resume: false, cancel: true, push: false, steer: true },
    ],
    [
      { status: "finished", stopReason: "clean" },
      { pause: false, resume: false, cancel: false, push: true, steer: false },
    ],
    [{ status: "finished", stopReason: "round_cap" }, { push: false }],
    [
      { status: "finished", stopReason: "clean", prUrl: "https://github.com/o/r/pull/3" },
      { push: false },
    ],
    [{ status: "failed" }, { cancel: false, steer: true, retry: true }],
    [{ status: "failed", stage: "done" }, { retry: false }],
    [{ status: "cancelled" }, { retry: false, steer: false }],
    [{ status: "finished", stopReason: "clean" }, { retry: false }],
    [{ status: "finished", stopReason: "clean_above_floor" }, { push: true }],
  ] as const)("%o", (patch, want) => {
    expect(with_(patch as Partial<RunState>)).toMatchObject(want);
  });

  it("never offers push for a read-only run", () => {
    expect(
      runControls({
        ...base,
        status: "finished",
        stopReason: "clean",
        request: { ...base.request, readOnly: true },
      }).push,
    ).toBe(false);
  });
});

describe("links and labels", () => {
  it.each([
    [undefined, null],
    ["https://github.com/octo/app/pull/12", "https://github.com/octo/app/commit/abc1234"],
    ["https://example.com/x", null],
  ])("commitUrl(%s)", (pr, want) => {
    expect(commitUrl(pr, "abc1234")).toBe(want);
  });

  it.each([
    ["claude-opus", "claude"],
    ["codex-gpt-5.5", "codex"],
    ["copilot-auto", "copilot"],
    ["Codex", "codex"],
    ["gemini", null],
  ])("vendorOfLabel(%s)", (label, want) => {
    expect(vendorOfLabel(label)).toBe(want);
  });
});
