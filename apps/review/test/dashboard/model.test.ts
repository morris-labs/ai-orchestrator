import type { AgentBoxEvent, TimedUsageSample } from "@agentbox/contracts";
import {
  addUsageSamples,
  applyEvent,
  edgeKey,
  emptyDashboard,
  replay,
  seriesKey,
  upsertRound,
} from "@agentbox/ui/dashboard";
import { describe, expect, it } from "vitest";
import { CONTAINER, RUN_ID } from "../../scripts/demoIds.js";
import { loadDemoEvents } from "../helpers/stream.js";

const events = loadDemoEvents();
const state = replay(events);

describe("applyEvent over the demo stream", () => {
  it("tracks the cursor and the event count", () => {
    expect(state.eventCount).toBe(events.length);
    expect(state.cursor).toEqual({ streamId: "server-demo-1", seq: events.length });
  });

  it("builds the container from changed, stats, and ports events", () => {
    const c = state.containers[CONTAINER]!;
    expect(c.state).toBe("running");
    expect(c.engine?.versionMatches).toBe(true);
    expect(c.cpuPercent).toBe(48.2);
    expect(c.listeners.map((l) => l.port)).toEqual([5173]);
  });

  it("ends the run waiting for a decision, with the round 1 summary", () => {
    const run = state.runs[RUN_ID]!;
    expect(run.run?.status).toBe("waiting_decision");
    expect(run.stage).toBe("merge");
    expect(run.round).toBe(2);
    expect(run.rounds.map((r) => r.round)).toEqual([1]);
    expect(run.reassignments).toHaveLength(1);
  });

  it("keeps the latest version of each finding", () => {
    const f = state.runs[RUN_ID]!.findings;
    expect(Object.keys(f).sort()).toEqual([
      "F-0001",
      "F-0002",
      "F-0003",
      "F-0004",
      "F-0007",
      "F-0008",
    ]);
    expect(f["F-0001"]!.verdict).toBe("fixed");
  });

  it("finishes every agent it started", () => {
    const agents = Object.values(state.agents);
    expect(agents.length).toBeGreaterThan(5);
    expect(agents.every((a) => a.finishedAt !== null && a.elapsedMs !== null)).toBe(true);
  });

  it("adds handoff counts per edge", () => {
    const key = edgeKey(
      { stage: "group", vendor: "copilot", role: null },
      { stage: "find", vendor: "copilot", role: "reviewer" },
    );
    expect(state.flows[key]).toBeUndefined();
    const toMerge = Object.values(state.flows).filter((e) => e.to.stage === "merge");
    expect(toMerge.reduce((s, e) => s + e.total, 0)).toBe(5 + 3 + 2 + 1);
  });

  it("collects usage per account and window, and records the ceiling crossing", () => {
    expect(
      state.usage[seriesKey("codex", "user@example.com", "5h")]!.map((s) => s.utilization),
    ).toEqual([0.41, 0.55, 0.72]);
    expect(state.ceilings[seriesKey("codex", "user@example.com", "5h")]!.above).toBe(true);
  });

  it("collects notifications and counts no unexpected terminal end", () => {
    expect(state.notifications.map((n) => n.kind)).toEqual(["round_summary", "decision_needed"]);
    expect(state.unexpectedEnds).toBe(0);
    expect(state.settingsChangedAt).not.toBeNull();
  });

  it("adds live cost per round from finished agents", () => {
    const cost = state.runs[RUN_ID]!.liveCostByRound;
    expect(cost[1]).toBeCloseTo(0.42 + 0.04 + 0.31 + 0.22 + 0.05 + 0.95 + 0.12);
    expect(cost[2]).toBeCloseTo(0.75);
  });
});

describe("applyEvent edge cases", () => {
  const base = {
    id: "x",
    time: "2026-10-28T10:00:00.000Z",
    source: "server",
    streamId: "s",
    seq: 1,
    sourceSeq: 1,
  };

  it("drops a removed container and a removed box", () => {
    let s = replay(events);
    s = applyEvent(s, {
      ...base,
      type: "container.changed",
      container: CONTAINER,
      projectId: "p",
      state: "removed",
      engine: null,
    } as AgentBoxEvent);
    expect(s.containers[CONTAINER]).toBeUndefined();
    s = applyEvent(s, {
      ...base,
      type: "box.changed",
      boxId: "claude-agent-emails_not_sending",
      status: "stopped",
      box: null,
    } as AgentBoxEvent);
    expect(Object.keys(s.boxes)).toEqual([]);
  });

  it("ignores ports for an unknown container", () => {
    const s = applyEvent(emptyDashboard(), {
      ...base,
      type: "ports.changed",
      container: "c",
      listeners: [],
    } as AgentBoxEvent);
    expect(s.containers).toEqual({});
  });

  it("counts an unexpected terminal end", () => {
    const s = applyEvent(emptyDashboard(), {
      ...base,
      type: "terminal.ended",
      terminalId: "t",
      boxId: null,
      kind: "session",
      exitCode: 1,
      unexpected: true,
    } as AgentBoxEvent);
    expect(s.unexpectedEnds).toBe(1);
  });
});

describe("addUsageSamples", () => {
  const sample = (time: string, utilization: number): TimedUsageSample => ({
    vendor: "claude",
    account: "a",
    window: "5h",
    utilization,
    spendUsd: null,
    ceiling: { kind: "utilization", window: "5h", max: 0.6 },
    resetAt: null,
    source: "rate_limit_event",
    time,
  });

  it("sorts by time and skips duplicates", () => {
    const s = addUsageSamples(emptyDashboard(), [
      sample("2026-10-28T10:00:00.000Z", 0.2),
      sample("2026-10-28T09:00:00.000Z", 0.1),
      sample("2026-10-28T10:00:00.000Z", 0.2),
    ]);
    expect(s.usage[seriesKey("claude", "a", "5h")]!.map((p) => p.utilization)).toEqual([0.1, 0.2]);
  });

  it("returns the same state for no samples", () => {
    const s = emptyDashboard();
    expect(addUsageSamples(s, [])).toBe(s);
  });
});

describe("upsertRound", () => {
  it("replaces a round and keeps order", () => {
    const r = (round: number, costUsd: number) => ({
      runId: RUN_ID,
      round,
      perVendor: {},
      fixed: 0,
      overlapRate: 0,
      costUsd,
      startedAt: "2026-10-28T09:00:00.000Z",
      finishedAt: "2026-10-28T09:00:00.000Z",
    });
    expect(upsertRound([r(2, 1), r(1, 1)], r(1, 5)).map((x) => [x.round, x.costUsd])).toEqual([
      [1, 5],
      [2, 1],
    ]);
  });
});
