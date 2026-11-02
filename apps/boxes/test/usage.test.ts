import type { TimedUsageSample, UsageWindow } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { vendorRows, type VendorUsageInput } from "../src/logic/usage";

const NOW = new Date("2026-06-10T12:00:00.000Z");

function sample(window: UsageWindow, over: Partial<TimedUsageSample> = {}): TimedUsageSample {
  return {
    vendor: "codex",
    account: "codex/personal",
    window,
    utilization: 0.37,
    spendUsd: null,
    ceiling: { kind: "utilization", window: "5h", max: 0.9 },
    resetAt: "2026-06-10T14:00:00.000Z",
    sampleSource: "codex_session",
    time: "2026-06-10T11:55:00.000Z",
    ...over,
  };
}

function vendor(latest: TimedUsageSample[], over: Partial<VendorUsageInput> = {}) {
  return {
    vendor: "codex",
    account: "codex/personal",
    latest,
    overCeiling: false,
    window: "5h" as const,
    ...over,
  };
}

describe("vendorRows", () => {
  it("shows each reported window with its own percentage and reset time", () => {
    const [row] = vendorRows(
      [
        vendor([
          sample("5h"),
          sample("7d", { utilization: 0.96, resetAt: "2026-06-12T07:00:00.000Z" }),
        ]),
      ],
      NOW,
    );
    expect(row?.windows.map((w) => [w.name, w.current?.label])).toEqual([
      ["5-hour block", "37%"],
      ["Weekly", "96%"],
    ]);
    expect(row?.windows[0]?.detail).toContain(
      new Date("2026-06-10T14:00:00.000Z").toLocaleString(),
    );
    expect(row?.windows[1]?.detail).toContain(
      new Date("2026-06-12T07:00:00.000Z").toLocaleString(),
    );
  });

  it("adds no window that has no sample", () => {
    const [row] = vendorRows([vendor([sample("5h")]), vendor([])], NOW);
    expect(row?.windows.map((w) => w.window)).toEqual(["5h"]);
    expect(vendorRows([vendor([])], NOW)[0]?.windows).toEqual([]);
  });

  it("doesn't show a window whose reset time has passed as current usage", () => {
    const stale = sample("5h", {
      resetAt: "2026-06-08T12:00:00.000Z",
      time: "2026-06-08T10:00:00.000Z",
    });
    const window = vendorRows([vendor([stale], { overCeiling: true })], NOW)[0]?.windows[0];
    expect(window?.current).toBeNull();
    expect(window?.detail).toContain("Last sample 2 days ago.");
  });

  it("treats a reset time equal to the present as passed", () => {
    const edge = sample("5h", { resetAt: NOW.toISOString() });
    expect(vendorRows([vendor([edge])], NOW)[0]?.windows[0]?.current).toBeNull();
  });

  it("keeps a live weekly window beside an expired 5-hour window", () => {
    const windows = vendorRows(
      [
        vendor([
          sample("5h", { resetAt: "2026-06-10T01:00:00.000Z" }),
          sample("7d", { resetAt: "2026-06-12T07:00:00.000Z" }),
        ]),
      ],
      NOW,
    )[0]?.windows;
    expect(windows?.map((w) => w.current !== null)).toEqual([false, true]);
  });

  it("marks only the ceiling's window as over", () => {
    const windows = vendorRows(
      [vendor([sample("5h"), sample("7d")], { overCeiling: true, window: "7d" })],
      NOW,
    )[0]?.windows;
    expect(windows?.map((w) => w.current?.label)).toEqual(["37%", "37% (over ceiling)"]);
  });

  it("shows spend and an unknown reset time", () => {
    const window = vendorRows(
      [vendor([sample("month", { spendUsd: 12.5, resetAt: null })])],
      NOW,
    )[0]?.windows[0];
    expect(window?.name).toBe("Monthly");
    expect(window?.current?.label).toBe("$12.50");
    expect(window?.detail).toBe("Reset time unknown. Sample 5 min ago.");
  });
});
