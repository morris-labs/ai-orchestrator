import type { AioEvent, EventOf, TimedUsageSample } from "@aio/contracts";
import {
  addUsageSamples,
  applyEvent,
  CLOSED_RUN_LIMIT,
  type DashboardState,
  edgeKey,
  emptyDashboard,
  replay,
  runEdgeKey,
  seedDashboard,
  seriesKey,
  upsertRound,
  USAGE_HISTORY_LIMIT,
} from "../../src/dashboard";
import { makeBoxView, makeEvent, makeProject } from "../../src/testing";
import { describe, expect, it } from "vitest";
import {
  buildDemoEvents,
  DEMO_CONTAINER as CONTAINER,
  DEMO_RUN_ID as RUN_ID,
} from "../../src/testing/demoRun";

const events = buildDemoEvents();
const state = replay(events);

describe("applyEvent over the demo stream", () => {
  it("counts the events", () => {
    expect(state.eventCount).toBe(events.length);
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
    } as AioEvent);
    expect(s.containers[CONTAINER]).toBeUndefined();
    s = applyEvent(s, {
      ...base,
      type: "box.changed",
      boxId: "aio-agent-emails_not_sending",
      status: "stopped",
      box: null,
    } as AioEvent);
    expect(Object.keys(s.boxes)).toEqual([]);
  });

  it("ignores ports for an unknown container", () => {
    const s = applyEvent(emptyDashboard(), {
      ...base,
      type: "ports.changed",
      container: "c",
      listeners: [],
    } as AioEvent);
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
    } as AioEvent);
    expect(s.unexpectedEnds).toBe(1);
  });

  it("leaves a build's own agents and build events out of the review dashboard", () => {
    const before = replay(events);
    const agent = {
      runId: null,
      buildId: "01JB8Z5K3W6Q2V9X4T7R0M1N2Q",
      seat: "developer",
      step: "tasks",
      agentId: "B-A1",
      leaseId: "B-L1",
      vendor: "claude",
      model: "claude-sonnet-5",
      role: "fixer",
      groupId: null,
      round: 1,
    } as const;
    let s = applyEvent(before, makeEvent("agent.started", agent));
    s = applyEvent(
      s,
      makeEvent("agent.finished", {
        ...agent,
        outcome: "ok",
        elapsedMs: 10,
        tokens: { in: 1, out: 1 },
        premiumRequests: 0,
        costEstimate: 1,
      }),
    );
    s = applyEvent(
      s,
      makeEvent("build.task.changed", {
        buildId: agent.buildId,
        taskId: "T1",
        status: "done",
        previousStatus: "running",
      }),
    );
    expect(s.agents).toEqual(before.agents);
    expect(s.runs).toEqual(before.runs);
    expect(s.eventCount).toBe(before.eventCount + 3);
  });
});

describe("usage.sample events", () => {
  it("keeps the stream source out of the series and the sample source in it", () => {
    const event = {
      id: "e-1",
      time: "2026-10-28T10:00:00.000Z",
      source: "engine:aio-agent-proj-x",
      streamId: "s",
      seq: 1,
      sourceSeq: 1,
      type: "usage.sample",
      vendor: "codex",
      account: "a",
      window: "5h",
      utilization: 0.3,
      spendUsd: null,
      ceiling: { kind: "utilization", window: "5h", max: 0.7 },
      resetAt: null,
      sampleSource: "codex_session",
    } as AioEvent;
    const s = applyEvent(emptyDashboard(), event);
    const [point] = s.usage[seriesKey("codex", "a", "5h")]!;
    expect(point).toMatchObject({ sampleSource: "codex_session", time: event.time });
    expect(point).not.toHaveProperty("source");
    expect(point).not.toHaveProperty("streamId");
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
    sampleSource: "rate_limit_event",
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

describe("handoff edges", () => {
  const from = { stage: "find", vendor: "claude", role: "reviewer" } as const;
  const to = { stage: "merge", vendor: null, role: null } as const;
  const handoff = (runId: string, count: number) =>
    makeEvent("handoff", { runId, round: 1, from, to, artifact: "findings", count, file: null });

  it("keeps each run's edges and counts apart", () => {
    const s = replay([handoff("run-a", 4), handoff("run-b", 2), handoff("run-a", 1)]);
    expect(s.flows[runEdgeKey("run-a", from, to)]).toMatchObject({ total: 5, runId: "run-a" });
    expect(s.flows[runEdgeKey("run-b", from, to)]).toMatchObject({ total: 2, runId: "run-b" });
  });
});

describe("addUsageSamples with a long history", () => {
  it("keeps the newest samples up to the limit, in order", () => {
    const base = Date.parse("2026-10-28T00:00:00.000Z");
    const samples = Array.from({ length: USAGE_HISTORY_LIMIT + 10 }, (_, i) => ({
      vendor: "claude" as const,
      account: "a",
      window: "5h" as const,
      utilization: i / 10_000,
      spendUsd: null,
      ceiling: { kind: "utilization" as const, window: "5h" as const, max: 0.6 },
      resetAt: null,
      sampleSource: "rate_limit_event" as const,
      time: new Date(base + (USAGE_HISTORY_LIMIT + 10 - i) * 1000).toISOString(),
    }));
    const series = addUsageSamples(emptyDashboard(), samples).usage[
      seriesKey("claude", "a", "5h")
    ]!;
    expect(series).toHaveLength(USAGE_HISTORY_LIMIT);
    const times = series.map((x) => Date.parse(x.time));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(series[series.length - 1]!.utilization).toBe(0);
  });
});

describe("seedDashboard", () => {
  const demoRun = events.find(
    (e) => e.type === "run.changed" && e.run.status === "waiting_decision",
  );
  const run = (demoRun as Extract<typeof demoRun, { type: "run.changed" }>)!.run;
  const finding = events.find((e) => e.type === "finding.changed");
  const f = (finding as Extract<typeof finding, { type: "finding.changed" }>)!.finding;

  it("fills runs, findings, rounds, containers, and boxes from REST", () => {
    const project = makeProject({ root: "/w/app", id: "app-1" });
    const s = seedDashboard(emptyDashboard(), {
      runs: [run],
      rounds: { [run.id]: [] },
      findings: { [run.id]: [f] },
      projects: [
        {
          project,
          running: 1,
          total: 1,
          container: { name: "aio-agent-proj-app-1", state: "running", engine: null },
        },
      ],
      boxes: [makeBoxView({ box: { id: "aio-agent-x", targetDir: "/w/app" }, status: "running" })],
    });
    expect(s.runs[run.id]!.run?.status).toBe("waiting_decision");
    expect(s.runs[run.id]!.stage).toBe(run.stage);
    expect(s.runs[run.id]!.findings[f.id]).toEqual(f);
    expect(s.containers["aio-agent-proj-app-1"]).toMatchObject({
      projectId: "app-1",
      state: "running",
    });
    expect(s.boxes["aio-agent-x"]).toBe("running");
  });

  it("keeps state that events applied while the snapshot loaded", () => {
    const newer = applyEvent(
      emptyDashboard(),
      makeEvent("run.changed", { run: { ...run, status: "finished" }, roundSummary: null }),
    );
    const s = seedDashboard(newer, { runs: [run] });
    expect(s.runs[run.id]!.run?.status).toBe("finished");
  });

  it("skips boxes and containers that events removed while the snapshot loaded", () => {
    const project = makeProject({ root: "/w/app", id: "app-1" });
    const s = seedDashboard(emptyDashboard(), {
      runs: [],
      projects: [
        {
          project,
          running: 1,
          total: 1,
          container: { name: "aio-agent-proj-app-1", state: "running", engine: null },
        },
      ],
      boxes: [
        makeBoxView({ box: { id: "aio-agent-x", targetDir: "/w/app" }, status: "running" }),
        makeBoxView({ box: { id: "aio-agent-y", targetDir: "/w/app" }, status: "stopped" }),
      ],
      removed: {
        boxes: new Set(["aio-agent-x"]),
        containers: new Set(["aio-agent-proj-app-1"]),
      },
    });
    expect(s.boxes).toEqual({ "aio-agent-y": "stopped" });
    expect(s.containers).toEqual({});
  });
});

describe("agents that never report agent.finished", () => {
  const started = events.find((e) => e.type === "agent.started") as EventOf<"agent.started">;
  const runEvent = [...events]
    .reverse()
    .find((e) => e.type === "run.changed") as EventOf<"run.changed">;
  const run = runEvent.run;
  const running = (s: DashboardState) =>
    Object.values(s.agents).filter((a) => a.finishedAt === null).length;

  function withRunningAgent(start = state) {
    const s = applyEvent(
      start,
      makeEvent("agent.started", { ...started, agentId: "SYNTHETIC_agent", round: 3 }),
    );
    expect(running(s)).toBe(1);
    return s;
  }

  it("ends a run's running agents when the run ends", () => {
    const s = applyEvent(
      withRunningAgent(),
      makeEvent("run.changed", { run: { ...run, status: "failed" }, roundSummary: null }),
    );
    expect(running(s)).toBe(0);
    const a = s.agents[`${RUN_ID}/SYNTHETIC_agent`]!;
    expect(a.finishedAt).not.toBeNull();
    expect(a.outcome).toBeNull();
  });

  it("ends a project's running agents when its engine goes unhealthy", () => {
    const s = applyEvent(
      withRunningAgent(),
      makeEvent("container.changed", {
        container: CONTAINER,
        projectId: run.request.projectId,
        state: "running",
        engine: { hostPort: 20412, version: "1.0.0-dev", healthy: false, versionMatches: true },
      }),
    );
    expect(running(s)).toBe(0);
  });

  it("reopens the agents when the engine comes back", () => {
    const engine = { hostPort: 20412, version: "1.0.0-dev", versionMatches: true };
    const change = (healthy: boolean) =>
      makeEvent("container.changed", {
        container: CONTAINER,
        projectId: run.request.projectId,
        state: "running",
        engine: { ...engine, healthy },
      });
    const lost = applyEvent(withRunningAgent(), change(false));
    expect(running(lost)).toBe(0);
    expect(running(applyEvent(lost, change(true)))).toBe(1);
  });

  it("leaves other projects' agents running", () => {
    const s = applyEvent(
      withRunningAgent(),
      makeEvent("container.changed", {
        container: "aio-agent-proj-SYNTHETIC_other",
        projectId: "SYNTHETIC_other",
        state: "exited",
        engine: null,
      }),
    );
    expect(running(s)).toBe(1);
  });

  it("ends the agents of a run that a snapshot reports as ended", () => {
    const s = seedDashboard(withRunningAgent(emptyDashboard()), {
      runs: [{ ...run, status: "cancelled" }],
      time: "2026-10-28T12:00:00.000Z",
    });
    expect(running(s)).toBe(0);
  });

  it("keeps only the newest finished runs, with their agents and flows", () => {
    let s = emptyDashboard();
    const total = CLOSED_RUN_LIMIT + 5;
    const idOf = (i: number) => `SYNTHETIC_run_${String(i).padStart(3, "0")}`;
    for (let i = 0; i < total; i += 1) {
      const id = idOf(i);
      const at = new Date(Date.parse("2026-10-01T00:00:00.000Z") + i * 60_000).toISOString();
      s = applyEvent(s, makeEvent("agent.started", { ...started, runId: id, agentId: "a1" }));
      s = applyEvent(
        s,
        makeEvent("run.changed", {
          run: { ...run, id, status: "finished", updatedAt: at },
          roundSummary: null,
        }),
      );
    }
    expect(Object.keys(s.runs)).toHaveLength(CLOSED_RUN_LIMIT);
    expect(Object.keys(s.agents)).toHaveLength(CLOSED_RUN_LIMIT);
    expect(s.runs[idOf(0)]).toBeUndefined();
    expect(s.agents[`${idOf(0)}/a1`]).toBeUndefined();
    expect(s.runs[idOf(total - 1)]).toBeDefined();
  });
});
