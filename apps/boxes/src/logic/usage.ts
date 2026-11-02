// Turns the `usage.get` answer into the rows of the Model usage panel. A row
// lists only the windows that have a stored sample.
import type { TimedUsageSample, UsageWindow } from "@aio/contracts";
import { relativeTime } from "./format";

/** The fields of a `usage.get` vendor entry that the panel reads. */
export interface VendorUsageInput {
  vendor: string;
  account: string;
  latest: readonly TimedUsageSample[];
  overCeiling: boolean;
  /** The window that the vendor's ceiling applies to. */
  window: UsageWindow;
}

/** One window's reading. `current` is null once the window's reset time has passed. */
export interface WindowRow {
  window: UsageWindow;
  name: string;
  current: { fraction: number; label: string } | null;
  detail: string;
}

export interface VendorRow {
  vendor: string;
  account: string;
  windows: WindowRow[];
  /** True when the server blocks this account, which a row might not show. */
  over: boolean;
  /** True when the block has no row to carry its label. */
  overWithoutRow: boolean;
}

const WINDOW_NAMES: Record<UsageWindow, string> = {
  "5h": "5-hour block",
  "7d": "Weekly",
  month: "Monthly",
};

const WINDOW_ORDER: readonly UsageWindow[] = ["5h", "7d", "month"];

function windowRow(sample: TimedUsageSample, over: boolean, now: Date): WindowRow {
  const age = relativeTime(sample.time, now);
  const name = WINDOW_NAMES[sample.window];
  const resetMs = sample.resetAt === null ? null : Date.parse(sample.resetAt);
  const resetText = resetMs === null ? "" : new Date(resetMs).toLocaleString();
  if (resetMs !== null && resetMs <= now.getTime()) {
    return {
      window: sample.window,
      name,
      current: null,
      detail: `Reset ${resetText}. Last sample ${age}.`,
    };
  }
  const value =
    sample.spendUsd !== null
      ? `$${sample.spendUsd.toFixed(2)}`
      : `${Math.round(sample.utilization * 100)}%`;
  return {
    window: sample.window,
    name,
    current: {
      fraction: sample.utilization,
      label: `${value}${over ? " (over ceiling)" : ""}`,
    },
    detail: `${resetMs === null ? "Reset time unknown" : `Resets ${resetText}`}. Sample ${age}.`,
  };
}

/** Builds one row per vendor account, as of `now`. */
export function vendorRows(vendors: readonly VendorUsageInput[], now: Date): VendorRow[] {
  return vendors.map((v) => ({
    vendor: v.vendor,
    account: v.account,
    windows: WINDOW_ORDER.flatMap((window) => {
      const sample = v.latest.find((s) => s.window === window);
      return sample ? [windowRow(sample, v.overCeiling && window === v.window, now)] : [];
    }),
    over: v.overCeiling,
    overWithoutRow: v.overCeiling && !v.latest.some((s) => s.window === v.window),
  }));
}
