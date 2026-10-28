import { RunRequestSchema, type RoundSummary, type RunState } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import { Notifier } from "../../src/notify/notifier.js";
import { T0, iso, setup } from "../usage/helpers.js";

const RUN = "01JB8Z5K3W6Q2V9X4T7R0M1N2P";
const BOX = "claude-agent-mail";

const run = (fields: Partial<RunState> = {}): RunState => ({
  id: RUN,
  projectId: "mail-0123abcd",
  boxId: BOX,
  container: "claude-agent-proj-mail-0123abcd",
  request: RunRequestSchema.parse({
    projectId: "mail-0123abcd",
    repoPath: "/home/user/mail",
    tip: "claude/mail",
  }),
  status: "running",
  stage: "find",
  round: 1,
  profile: "offload",
  roles: { reviewer: ["codex"], disprover: "copilot", confirmer: "codex", fixer: "claude" },
  stopReason: null,
  decision: null,
  createdAt: iso(T0),
  updatedAt: iso(T0),
  ...fields,
});

const summary = (round: number): RoundSummary => ({
  runId: RUN,
  round,
  perVendor: {
    codex: {
      raised: 3,
      confirmed: 2,
      disproved: 1,
      tokensIn: 1,
      tokensOut: 1,
      premiumRequests: 0,
      costUsd: 0,
    },
  },
  fixed: 2,
  overlapRate: 0,
  costUsd: 0.5,
  startedAt: iso(T0),
  finishedAt: iso(T0),
});

function make() {
  const t = setup();
  let n = 0;
  const notifier = new Notifier({
    db: t.db,
    settings: () => t.settings.value,
    emit: (e) => t.hub.emit(e),
    idFn: () => `N-${(n += 1)}`,
  });
  t.hub.subscribe((e) => notifier.ingest(e));
  const runChanged = (state: RunState, roundSummary: RoundSummary | null = null) =>
    t.hub.emit({ type: "run.changed", run: state, roundSummary });
  const terminalEnded = (unexpected: boolean, kind: "session" | "shell" = "session") =>
    t.hub.emit({
      type: "terminal.ended",
      terminalId: "T-1",
      boxId: BOX,
      kind,
      exitCode: 1,
      unexpected,
    });
  const kinds = () => t.ofType("notification").map((e) => e.kind);
  return { ...t, notifier, runChanged, terminalEnded, kinds };
}

describe("Notifier", () => {
  it("notifies once when a run starts waiting for a decision", () => {
    const t = make();
    t.runChanged(run());
    const decision = {
      kind: "oscillation" as const,
      findingIds: ["F-1"],
      options: ["resume" as const],
      message: "F-1 came back after its fix.",
    };
    t.runChanged(run({ status: "waiting_decision", decision }));
    t.runChanged(run({ status: "waiting_decision", decision }));
    expect(t.kinds()).toEqual(["decision_needed"]);
    expect(t.ofType("notification")[0]).toMatchObject({
      notificationId: "N-1",
      body: "F-1 came back after its fix.",
      runId: RUN,
      boxId: BOX,
      severity: "warning",
      read: false,
    });
  });

  it("tells ready to push apart from other finishes", () => {
    const t = make();
    t.runChanged(run({ status: "finished", stopReason: "clean" }));
    const other = make();
    other.runChanged(run({ status: "finished", stopReason: "round_cap" }));
    const readOnly = make();
    readOnly.runChanged(
      run({
        status: "finished",
        stopReason: "clean",
        request: { ...run().request, readOnly: true },
      }),
    );
    expect(t.kinds()).toEqual(["ready_to_push"]);
    expect(other.kinds()).toEqual(["run_finished"]);
    expect(readOnly.kinds()).toEqual(["run_finished"]);
  });

  it("gates ready to push and other finishes by their own toggles", () => {
    const t = make();
    t.settings.value = {
      ...t.settings.value,
      notifications: { ...t.settings.value.notifications, runFinished: false },
    };
    t.runChanged(run({ status: "finished", stopReason: "clean" }));
    t.runChanged(
      run({ id: "01JB8Z5K3W6Q2V9X4T7R0M1N2Z", status: "finished", stopReason: "round_cap" }),
    );
    expect(t.kinds()).toEqual(["ready_to_push"]);

    const u = make();
    u.settings.value = {
      ...u.settings.value,
      notifications: { ...u.settings.value.notifications, readyToPush: false },
    };
    u.runChanged(run({ status: "finished", stopReason: "clean" }));
    u.runChanged(
      run({ id: "01JB8Z5K3W6Q2V9X4T7R0M1N2Z", status: "finished", stopReason: "round_cap" }),
    );
    expect(u.kinds()).toEqual(["run_finished"]);
  });

  it("notifies a failed run as an error", () => {
    const t = make();
    t.runChanged(run({ status: "failed", error: "The gate crashed." }));
    expect(t.ofType("notification")[0]).toMatchObject({
      kind: "run_finished",
      severity: "error",
      body: "The gate crashed.",
    });
  });

  it("notifies each round summary once", () => {
    const t = make();
    t.runChanged(run(), summary(1));
    t.runChanged(run(), summary(1));
    t.runChanged(run({ round: 2 }), summary(2));
    expect(t.kinds()).toEqual(["round_summary", "round_summary"]);
    expect(t.ofType("notification")[0]?.title).toBe("Round 1 finished");
  });

  it("notifies an unexpected session end only", () => {
    const t = make();
    t.terminalEnded(false);
    t.terminalEnded(true, "shell");
    t.terminalEnded(true);
    expect(t.kinds()).toEqual(["box_ended"]);
  });

  it("respects the toggles", () => {
    const t = make();
    t.settings.value = {
      ...t.settings.value,
      notifications: {
        decisionNeeded: false,
        runFinished: false,
        readyToPush: false,
        boxEnded: false,
        roundSummary: false,
      },
    };
    t.runChanged(run({ status: "waiting_decision" }), summary(1));
    t.runChanged(run({ status: "finished", stopReason: "clean" }));
    t.runChanged(run({ status: "failed" }));
    t.terminalEnded(true);
    expect(t.kinds()).toEqual([]);
  });

  it("lists newest first and marks notifications read", () => {
    const t = make();
    t.runChanged(run({ status: "waiting_decision" }));
    t.terminalEnded(true);
    expect(t.notifier.list().map((n) => n.notificationId)).toEqual(["N-2", "N-1"]);
    expect(t.notifier.markRead("N-1")).toBe(true);
    expect(t.notifier.markRead("N-9")).toBe(false);
    expect(t.notifier.list({ unread: true }).map((n) => n.notificationId)).toEqual(["N-2"]);
    expect(t.notifier.list({ unread: false })).toMatchObject([
      { notificationId: "N-1", read: true },
    ]);
  });
});
