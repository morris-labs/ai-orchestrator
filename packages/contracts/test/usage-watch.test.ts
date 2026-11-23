// The usage watcher's settings: thresholds for each window and the build
// estimate factor, with defaults when the settings name none.
import { describe, expect, it } from "vitest";
import {
  BuildSummarySchema,
  DEFAULT_USAGE_WATCH,
  GlobalSettingsPatchSchema,
  GlobalSettingsSchema,
  NotificationSchema,
  defaultConfig,
  usageWatchOf,
} from "../src/index.js";
import { roundTrip } from "./helpers.js";

describe("usage watch settings", () => {
  it("defaults each window to its own thresholds", () => {
    const watch = usageWatchOf(defaultConfig());
    expect(watch).toEqual(DEFAULT_USAGE_WATCH);
    expect(watch["5h"]).toEqual({ ceilingAt: 0.8, jump: 0.15, jumpMinutes: 10 });
    expect(watch["7d"].ceilingAt).toBe(0.8);
    expect(watch.buildEstimateFactor).toBe(2);
  });

  it("holds separate thresholds for the 5-hour and the 7-day windows", () => {
    const usageWatch = {
      "5h": { ceilingAt: 0.7, jump: 0.2, jumpMinutes: 15 },
      "7d": { ceilingAt: 0.9, jump: 0.05, jumpMinutes: 120 },
      buildEstimateFactor: 3,
    };
    const settings = roundTrip(GlobalSettingsSchema, { ...defaultConfig(), usageWatch });
    expect(usageWatchOf(settings)).toEqual(usageWatch);
  });

  it("rejects a threshold outside 0 to 1 and a factor under 1", () => {
    const base = defaultConfig();
    const bad = (usageWatch: unknown) =>
      GlobalSettingsSchema.safeParse({ ...base, usageWatch }).success;
    expect(
      bad({ ...DEFAULT_USAGE_WATCH, "5h": { ...DEFAULT_USAGE_WATCH["5h"], ceilingAt: 1.2 } }),
    ).toBe(false);
    expect(bad({ ...DEFAULT_USAGE_WATCH, "7d": { ...DEFAULT_USAGE_WATCH["7d"], jump: 0 } })).toBe(
      false,
    );
    expect(bad({ ...DEFAULT_USAGE_WATCH, buildEstimateFactor: 0.5 })).toBe(false);
  });

  it("patches one window's thresholds, and null goes back to the defaults", () => {
    expect(GlobalSettingsPatchSchema.parse({ usageWatch: { "7d": { ceilingAt: 0.9 } } })).toEqual({
      usageWatch: { "7d": { ceilingAt: 0.9 } },
    });
    expect(GlobalSettingsPatchSchema.parse({ usageWatch: null })).toEqual({ usageWatch: null });
    expect(GlobalSettingsPatchSchema.safeParse({ usageWatch: { "1h": {} } }).success).toBe(false);
  });
});

describe("usage alert notifications", () => {
  it("names the build an alert is about", () => {
    const n = roundTrip(NotificationSchema, {
      notificationId: "n-1",
      kind: "usage_alert",
      title: "Build passed twice its usage estimate",
      body: "B",
      runId: null,
      boxId: null,
      buildId: "01JB8Z5K3W6Q2V9X4T7R0M1N2P",
      severity: "warning",
      read: false,
    });
    expect(n.kind).toBe("usage_alert");
    expect(n.buildId).toBe("01JB8Z5K3W6Q2V9X4T7R0M1N2P");
  });
});

describe("build usage estimate on the build summary", () => {
  const summary = {
    id: "01JB8Z5K3W6Q2V9X4T7R0M1N2P",
    slug: "settings-page",
    projectId: "proj-1",
    container: "aio-agent-proj-example",
    status: "running",
    step: "tasks",
    boxId: null,
    createdAt: "2026-10-28T09:00:00.000Z",
    updatedAt: "2026-10-28T09:00:00.000Z",
  };

  it("carries the plan's usage estimate so the watcher can compare against it", () => {
    const build = roundTrip(BuildSummarySchema, {
      ...summary,
      usageEstimate: { low: 1000, high: 5000 },
    });
    expect(build.usageEstimate).toEqual({ low: 1000, high: 5000 });
  });

  it("leaves the estimate out for a build without one", () => {
    expect(BuildSummarySchema.parse(summary).usageEstimate).toBeUndefined();
  });
});
