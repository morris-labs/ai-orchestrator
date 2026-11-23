// The usage watcher: ceiling, jump, and build estimate alerts, each with an
// injected clock, and each once per crossing.
import {
  EventSchema,
  type BuildSummary,
  type LeaseSettlement,
  type UsageSample,
  type Vendor,
} from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { BuildMirror } from "../../src/events/build-mirror.js";
import {
  UsageWatcher,
  projectManagerBoxes,
  projectManagerMessage,
  type UsageAlert,
} from "../../src/usage/watcher.js";
import { MIN, T0, iso, setup } from "./helpers.js";

const BUILD = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";

function watch(options: { alerted?: (buildId: string) => boolean } = {}) {
  const t = setup();
  const builds = new BuildMirror(t.db);
  const alerts: UsageAlert[] = [];
  const make = () =>
    new UsageWatcher({
      store: t.store,
      settings: () => t.settings.value,
      build: (id) => builds.get(id),
      alerted: options.alerted ?? (() => false),
      alert: (a) => alerts.push(a),
    });
  let watcher = make();
  /** Takes a sample at `minutes` after T0 and feeds it to the usage service and the watcher. */
  const at = (minutes: number, utilization: number, fields: Partial<UsageSample> = {}) => {
    t.clock.now = T0 + minutes * MIN;
    watcher.ingest(t.sample("claude" as Vendor, { window: "5h", utilization, ...fields }));
  };
  let seq = 1000;
  const settle = (tokensIn: number, fields: Partial<LeaseSettlement> = {}) => {
    seq += 1;
    const event = EventSchema.parse({
      id: `s${seq}`,
      time: iso(t.clock.now),
      source: "engine:aio-agent-proj-example-app-1a2b3c4d",
      streamId: "S",
      seq,
      sourceSeq: seq,
      type: "lease.settled",
      leaseId: `L${seq}`,
      runId: null,
      buildId: BUILD,
      vendor: "claude",
      role: "fixer",
      tokens: { in: tokensIn, out: 0 },
      premiumRequests: 0,
      costEstimate: 0,
      ...fields,
    });
    t.usage.ingest(event);
    watcher.ingest(event);
  };
  const putBuild = (fields: Partial<BuildSummary> = {}) =>
    builds.upsert({
      id: BUILD,
      slug: "settings-page",
      projectId: "proj-1",
      container: "aio-agent-proj-example-app-1a2b3c4d",
      status: "running",
      step: "tasks",
      boxId: "box-1",
      createdAt: iso(T0),
      updatedAt: iso(T0),
      ...fields,
    });
  const restart = () => {
    watcher = make();
  };
  return { t, alerts, at, settle, putBuild, restart };
}

describe("ceiling alert", () => {
  it("alerts once when the 5-hour window passes 80% and the burn rate reaches 100% before the reset", () => {
    const w = watch();
    w.at(0, 0.7);
    w.at(10, 0.78);
    expect(w.alerts).toEqual([]);
    w.at(20, 0.82);
    w.at(30, 0.86);
    w.at(40, 0.9);

    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0]).toMatchObject({ rule: "ceiling", vendor: "claude", window: "5h" });
    expect(w.alerts[0]?.title).toMatch(/82%/);
  });

  it("stays quiet past 80% when the window resets before the burn reaches 100%", () => {
    const w = watch();
    const soon = iso(T0 + 30 * MIN);
    w.at(0, 0.8, { resetAt: soon });
    w.at(10, 0.82, { resetAt: soon });
    w.at(20, 0.84, { resetAt: soon });

    expect(w.alerts).toEqual([]);
  });

  it("alerts again after the window resets and passes the threshold again", () => {
    const w = watch();
    w.at(0, 0.7);
    w.at(10, 0.85);
    const next = iso(T0 + 600 * MIN);
    w.at(310, 0.1, { resetAt: next });
    w.at(320, 0.5, { resetAt: next });
    w.at(330, 0.85, { resetAt: next });

    expect(w.alerts.filter((a) => a.rule === "ceiling")).toHaveLength(2);
  });
});

describe("burn alarm", () => {
  it("alerts once on more than 15% of the window in 10 minutes", () => {
    const w = watch();
    w.at(0, 0.1);
    w.at(5, 0.2);
    expect(w.alerts).toEqual([]);
    w.at(9, 0.3);
    w.at(12, 0.4);
    w.at(15, 0.5);

    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0]).toMatchObject({ rule: "jump", vendor: "claude", window: "5h" });
  });

  it("doesn't alert on the same rise spread over a longer span", () => {
    const w = watch();
    w.at(0, 0.1);
    w.at(8, 0.18);
    w.at(16, 0.26);
    w.at(24, 0.34);

    expect(w.alerts).toEqual([]);
  });

  it("alerts again on a second jump after usage calms down", () => {
    const w = watch();
    w.at(0, 0.1);
    w.at(5, 0.3);
    w.at(20, 0.32);
    w.at(40, 0.34);
    w.at(45, 0.55);

    expect(w.alerts.filter((a) => a.rule === "jump")).toHaveLength(2);
  });
});

describe("7-day window", () => {
  it("uses the thresholds the owner set for the 7-day window, not the 5-hour ones", () => {
    const w = watch();
    w.t.settings.value = {
      ...w.t.settings.value,
      usageWatch: {
        "5h": { ceilingAt: 0.5, jump: 0.01, jumpMinutes: 10 },
        "7d": { ceilingAt: 0.9, jump: 0.4, jumpMinutes: 60 },
        buildEstimateFactor: 2,
      },
    };
    const weekly = { window: "7d" as const, resetAt: iso(T0 + 3 * 24 * 60 * MIN) };
    w.at(0, 0.6, weekly);
    w.at(30, 0.85, weekly);
    expect(w.alerts).toEqual([]);
    w.at(60, 0.92, weekly);

    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0]).toMatchObject({ rule: "ceiling", window: "7d" });
  });

  it("alerts on a jump in the 7-day window by its own span", () => {
    const w = watch();
    const weekly = { window: "7d" as const, resetAt: iso(T0 + 3 * 24 * 60 * MIN) };
    w.at(0, 0.1, weekly);
    w.at(50, 0.16, weekly);

    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0]).toMatchObject({ rule: "jump", window: "7d" });
  });
});

describe("after a restart", () => {
  it("doesn't repeat an alert for a crossing it already reported", () => {
    const w = watch();
    w.at(0, 0.75);
    w.at(10, 0.85);
    expect(w.alerts).toHaveLength(1);
    w.restart();
    w.at(20, 0.9);

    expect(w.alerts).toHaveLength(1);
  });
});

describe("build estimate alert", () => {
  it("alerts once when a build passes twice its high usage estimate", () => {
    const w = watch();
    w.putBuild({ usageEstimate: { low: 500, high: 1000 } });
    w.settle(1500);
    expect(w.alerts).toEqual([]);
    w.settle(600);
    w.settle(600);

    expect(w.alerts).toHaveLength(1);
    expect(w.alerts[0]).toMatchObject({
      rule: "build_estimate",
      buildId: BUILD,
      boxId: "box-1",
      vendor: null,
      window: null,
    });
  });

  it("never alerts for a build without an estimate", () => {
    const w = watch();
    w.putBuild();
    w.settle(1_000_000);

    expect(w.alerts).toEqual([]);
  });

  it("doesn't repeat the alert after a restart", () => {
    const fired = new Set<string>();
    const w = watch({ alerted: (id) => fired.has(id) });
    w.putBuild({ usageEstimate: { low: 500, high: 1000 } });
    w.settle(2500);
    fired.add(BUILD);
    w.restart();
    w.settle(100);

    expect(w.alerts).toHaveLength(1);
  });
});

describe("Project manager delivery", () => {
  const build = (id: string, fields: Partial<BuildSummary>): BuildSummary => ({
    id,
    slug: "s",
    projectId: "proj-1",
    container: "c",
    status: "running",
    step: "tasks",
    boxId: "box-1",
    createdAt: iso(T0),
    updatedAt: iso(T0),
    ...fields,
  });
  const builds = [
    build("01JB8Z5K3W6Q2V9X4T7R0M1N2A", { boxId: "box-1" }),
    build("01JB8Z5K3W6Q2V9X4T7R0M1N2B", { boxId: "box-2", status: "paused" }),
    build("01JB8Z5K3W6Q2V9X4T7R0M1N2C", { boxId: "box-3", status: "finished" }),
    build("01JB8Z5K3W6Q2V9X4T7R0M1N2D", { boxId: null }),
    build("01JB8Z5K3W6Q2V9X4T7R0M1N2E", { boxId: "box-1", status: "planning" }),
  ];
  const base: UsageAlert = {
    rule: "jump",
    title: "T",
    body: "B",
    vendor: "claude",
    account: "me@example.com",
    window: "5h",
    buildId: null,
    boxId: null,
  };

  it("sends a window alert to the Project manager of every active build, once per box", () => {
    expect(projectManagerBoxes(base, builds)).toEqual(["box-1", "box-2"]);
  });

  it("sends a build alert to that build's Project manager only", () => {
    expect(
      projectManagerBoxes(
        { ...base, rule: "build_estimate", buildId: "X", boxId: "box-9" },
        builds,
      ),
    ).toEqual(["box-9"]);
    expect(projectManagerBoxes({ ...base, rule: "build_estimate", buildId: "X" }, builds)).toEqual(
      [],
    );
  });

  it("words the message for the Project manager's session as one line", () => {
    const text = projectManagerMessage({
      ...base,
      title: "Claude usage jumped",
      body: "Line one.\nLine two.",
    });
    expect(text).not.toMatch(/\n/);
    expect(text).toMatch(/^Usage alert: Claude usage jumped\. Line one\. Line two\./);
    expect(text).toMatch(/owner/);
  });
});
