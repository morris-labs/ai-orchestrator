import {
  agentElapsed,
  diagramSize,
  edgePath,
  fleetRows,
  focusRunId,
  formatBytes,
  formatCount,
  formatDuration,
  formatPercent,
  formatUsd,
  funnel,
  linearForecast,
  linearScale,
  nearestIndex,
  niceTicks,
  nodePosition,
  overallOverlap,
  replay,
  roundPoints,
  runningPerVendor,
  usageSeries,
  usedNodes,
  agentRows,
  type AgentView,
} from "../../src/dashboard";
import { describe, expect, it } from "vitest";
import { buildDemoEvents, DEMO_RUN_ID as RUN_ID } from "../../src/testing/demoRun";

const state = replay(buildDemoEvents());
const run = state.runs[RUN_ID]!;

describe("run health", () => {
  it("builds the funnel from raised to fixed", () => {
    // Six merged findings; F-0001 was also raised by Copilot.
    expect(funnel(run)).toEqual({ raised: 8, merged: 6, confirmed: 2, fixed: 2 });
  });

  it("computes the overlap over the whole run", () => {
    expect(overallOverlap(run)).toBeCloseTo(1 / 6);
  });

  it("lists summarized rounds and the live round", () => {
    const points = roundPoints(run);
    expect(points.map((p) => [p.round, p.live])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(points[0]!.confirmed).toEqual({ claude: 0, codex: 2, copilot: 1 });
    expect(points[1]!.costUsd).toBeCloseTo(0.75);
  });

  it("focuses the active run", () => {
    expect(focusRunId(state)).toBe(RUN_ID);
  });
});

describe("fleet and agents", () => {
  it("marks the container connected with its active run", () => {
    const [row] = fleetRows(state);
    expect(row!.connection).toBe("connected");
    expect(row!.versionMatches).toBe(true);
    expect(row!.activeRuns).toEqual([
      { runId: RUN_ID, stage: "merge", round: 2, status: "waiting_decision" },
    ]);
    expect(row!.memFraction).toBeCloseTo(3.1 / 8);
  });

  const agent = (patch: Partial<AgentView>): AgentView => ({
    agentId: "a",
    runId: "r",
    vendor: "claude",
    model: "m",
    role: "reviewer",
    groupId: null,
    round: 1,
    startedAt: "2026-10-28T09:00:00.000Z",
    finishedAt: null,
    outcome: null,
    elapsedMs: null,
    tokens: null,
    costEstimate: null,
    ...patch,
  });

  it("counts running agents per vendor", () => {
    expect(
      runningPerVendor([agent({}), agent({ vendor: "codex" }), agent({ finishedAt: "x" })]),
    ).toEqual({
      claude: 1,
      codex: 1,
      copilot: 0,
    });
  });

  it("measures elapsed time live until the agent finishes", () => {
    const t = Date.parse("2026-10-28T09:00:30.000Z");
    expect(agentElapsed(agent({}), t)).toBe(30_000);
    expect(agentElapsed(agent({ elapsedMs: 5 }), t)).toBe(5);
  });

  it("filters agents by run", () => {
    expect(agentRows(state, "other")).toEqual([]);
    expect(agentRows(state, RUN_ID).length).toBe(Object.keys(state.agents).length);
  });
});

describe("linearForecast", () => {
  const h = 3600_000;
  it.each([
    {
      name: "rising line",
      pts: [
        [0, 0.1],
        [h, 0.3],
      ],
      ceiling: 0.6,
      reset: null,
      want: 2.5 * h,
    },
    {
      name: "flat line",
      pts: [
        [0, 0.3],
        [h, 0.3],
      ],
      ceiling: 0.6,
      reset: null,
      want: null,
    },
    {
      name: "crosses after the reset",
      pts: [
        [0, 0.1],
        [h, 0.2],
      ],
      ceiling: 0.6,
      reset: 2 * h,
      want: null,
    },
    {
      name: "already over",
      pts: [
        [0, 0.5],
        [h, 0.7],
      ],
      ceiling: 0.6,
      reset: null,
      want: h,
    },
    {
      name: "restarts after a window reset",
      pts: [
        [0, 0.5],
        [h, 0.1],
        [2 * h, 0.2],
      ],
      ceiling: 0.6,
      reset: null,
      want: 6 * h,
    },
    { name: "one point", pts: [[0, 0.1]], ceiling: 0.6, reset: null, want: null },
  ])("$name", ({ pts, ceiling, reset, want }) => {
    const points = pts.map(([time, utilization]) => ({ time: time!, utilization: utilization! }));
    expect(linearForecast(points, ceiling, reset)).toBe(want);
  });
});

describe("usageSeries", () => {
  it("orders by vendor and prefers the server forecast", () => {
    const series = usageSeries(state, [
      {
        vendor: "claude",
        account: "user@example.com",
        window: "5h",
        forecastAt: "2026-10-28T11:00:00.000Z",
        resetAt: null,
      },
    ]);
    expect(series.map((s) => s.vendor)).toEqual(["claude", "codex", "copilot"]);
    expect(series[0]!.forecastAt).toBe(Date.parse("2026-10-28T11:00:00.000Z"));
    expect(series[0]!.serverForecast).toBe(true);
    expect(series[2]!.ceiling).toBe(1);
    expect(series[1]!.ceiling).toBe(0.7);
  });
});

describe("flow layout", () => {
  it("places lanes and stages on a grid", () => {
    const a = nodePosition("find", "codex");
    const b = nodePosition("merge", "pipeline");
    expect(b.x).toBeGreaterThan(a.x);
    expect(a.y).toBeGreaterThan(b.y);
    expect(diagramSize().width).toBeGreaterThan(b.x);
  });

  it("draws an S-curve between columns and an arc within one", () => {
    expect(
      edgePath({
        from: { stage: "find", vendor: "codex", role: null },
        to: { stage: "merge", vendor: null, role: null },
      }),
    ).toMatch(/^M[\d.]+,[\d.]+ C/);
    const same = edgePath({
      from: { stage: "find", vendor: "codex", role: null },
      to: { stage: "find", vendor: "claude", role: null },
    });
    expect(same).toContain("C");
  });

  it("deduplicates nodes", () => {
    const e = {
      from: { stage: "find" as const, vendor: null, role: null },
      to: { stage: "merge" as const, vendor: null, role: null },
    };
    expect(usedNodes([e, e])).toHaveLength(2);
  });
});

describe("scales and formatting", () => {
  it("maps linearly", () => {
    const s = linearScale([0, 10], [100, 200]);
    expect(s(5)).toBe(150);
  });

  it.each([
    [0, 1, [0, 0.25, 0.5, 0.75, 1]],
    [0, 7, [0, 2, 4, 6]],
    [5, 5, [5]],
  ])("niceTicks(%d, %d)", (min, max, want) => {
    expect(niceTicks(min, max, 4)).toEqual(want);
  });

  it("finds the nearest index", () => {
    expect(nearestIndex([0, 10, 20], 14)).toBe(1);
  });

  it.each([
    [formatBytes(null), "–"],
    [formatBytes(512), "512 B"],
    [formatBytes(1536), "1.5 KiB"],
    [formatBytes(3_100_000_000), "2.9 GiB"],
    [formatDuration(5_000), "5s"],
    [formatDuration(125_000), "2m 05s"],
    [formatDuration(3_725_000), "1h 02m"],
    [formatCount(1284), "1,284"],
    [formatCount(12_900), "12.9K"],
    [formatCount(2_500_000), "2.5M"],
    [formatUsd(0.5), "$0.50"],
    [formatUsd(42.4), "$42"],
    [formatPercent(0.725), "73%"],
  ])("formats %s", (got, want) => {
    expect(got).toBe(want);
  });
});
