// Derived views of the dashboard state. Every function here is pure, so the
// components stay thin and the numbers are testable without rendering.
import type { RunStatus, Stage, TimedUsageSample, UsageSource, Vendor } from "@aio/contracts";
import type { AgentView, ContainerView, DashboardState, RunView } from "./model.js";
import { VENDORS } from "./tokens.js";

/** Run statuses that hold resources and count as active. */
export const ACTIVE_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "paused",
  "waiting_decision",
];

export function isActive(run: RunView): boolean {
  return run.run !== null && ACTIVE_STATUSES.includes(run.run.status);
}

export interface FleetRow {
  container: ContainerView;
  connection: "connected" | "unhealthy" | "stopped" | "unknown";
  /** `true`, `false`, or `null` when the engine has not answered yet. */
  versionMatches: boolean | null;
  activeRuns: Array<{ runId: string; stage: Stage | null; round: number; status: RunStatus }>;
  memFraction: number | null;
}

/** One row per known container, sorted by name. */
export function fleetRows(state: DashboardState): FleetRow[] {
  const runs = Object.values(state.runs).filter(isActive);
  return Object.values(state.containers)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => {
      let connection: FleetRow["connection"] = "unknown";
      if (c.state === "running") connection = c.engine?.healthy ? "connected" : "unhealthy";
      else if (c.state === "exited" || c.state === "created") connection = "stopped";
      return {
        container: c,
        connection,
        versionMatches: c.engine?.versionMatches ?? null,
        activeRuns: runs
          .filter((r) => r.run?.container === c.name)
          .map((r) => ({
            runId: r.runId,
            stage: r.stage,
            round: r.round,
            status: r.run!.status,
          })),
        memFraction: c.memBytes !== null && c.memLimitBytes ? c.memBytes / c.memLimitBytes : null,
      };
    });
}

/** Agents, running first, then newest first. `runId` narrows to one run. */
export function agentRows(state: DashboardState, runId?: string): AgentView[] {
  return Object.values(state.agents)
    .filter((a) => runId === undefined || a.runId === runId)
    .sort((a, b) => {
      const running = Number(b.finishedAt === null) - Number(a.finishedAt === null);
      return running !== 0 ? running : Date.parse(b.startedAt) - Date.parse(a.startedAt);
    });
}

/** Running agents per vendor. */
export function runningPerVendor(agents: readonly AgentView[]): Record<Vendor, number> {
  const counts: Record<Vendor, number> = { claude: 0, codex: 0, copilot: 0 };
  for (const a of agents) if (a.finishedAt === null) counts[a.vendor] += 1;
  return counts;
}

/** Milliseconds an agent has run: final when finished, else up to `now`. */
export function agentElapsed(agent: AgentView, now: number): number {
  if (agent.elapsedMs !== null) return agent.elapsedMs;
  // An agent ended without `agent.finished` stops counting when it ended.
  const end = agent.finishedAt === null ? now : Date.parse(agent.finishedAt);
  return Math.max(0, end - Date.parse(agent.startedAt));
}

// ---------------------------------------------------------------------------
// Run health

export interface RoundVendorPoint {
  round: number;
  confirmed: Record<Vendor, number>;
  overlapRate: number;
  costUsd: number;
  /** True when the round has no summary yet and the cost comes from live agent events. */
  live: boolean;
}

/** Confirmed findings, overlap, and cost per round, from the round summaries and live costs. */
export function roundPoints(run: RunView): RoundVendorPoint[] {
  const points: RoundVendorPoint[] = run.rounds.map((s) => ({
    round: s.round,
    confirmed: Object.fromEntries(
      VENDORS.map((v) => [v, s.perVendor[v]?.confirmed ?? 0]),
    ) as Record<Vendor, number>,
    overlapRate: s.overlapRate,
    costUsd: s.costUsd,
    live: false,
  }));
  for (const [key, cost] of Object.entries(run.liveCostByRound)) {
    const round = Number(key);
    if (round < 1 || points.some((p) => p.round === round)) continue;
    points.push({
      round,
      confirmed: { claude: 0, codex: 0, copilot: 0 },
      overlapRate: 0,
      costUsd: cost,
      live: true,
    });
  }
  return points.sort((a, b) => a.round - b.round);
}

export interface Funnel {
  /** Every finding a reviewer reported, before the merge stage deduped them. */
  raised: number;
  merged: number;
  confirmed: number;
  fixed: number;
}

/**
 * The finding funnel. `raised` counts each reviewer's report, so a finding
 * that two reviewers raised counts twice; `confirmed` counts findings that
 * reached `confirmed` at any point, including those fixed or waived since.
 */
export function funnel(run: RunView): Funnel {
  const findings = Object.values(run.findings);
  let raised = 0;
  let confirmed = 0;
  let fixed = 0;
  for (const f of findings) {
    raised += 1 + f.alsoReportedBy.length;
    const everConfirmed =
      f.verdict === "confirmed" ||
      f.verdict === "fixed" ||
      f.history.some((h) => h.verdict === "confirmed");
    if (everConfirmed) confirmed += 1;
    if (f.verdict === "fixed") fixed += 1;
  }
  const fromSummaries = run.rounds.reduce(
    (sum, r) => sum + VENDORS.reduce((s, v) => s + (r.perVendor[v]?.raised ?? 0), 0),
    0,
  );
  return { raised: Math.max(raised, fromSummaries), merged: findings.length, confirmed, fixed };
}

/** Share of merged findings that more than one reviewer raised, over the whole run. */
export function overallOverlap(run: RunView): number | null {
  const findings = Object.values(run.findings);
  if (findings.length === 0) return null;
  return findings.filter((f) => f.alsoReportedBy.length > 0).length / findings.length;
}

/** The run to show by default: the newest active one, else the newest. */
export function focusRunId(state: DashboardState): string | null {
  const runs = Object.values(state.runs).filter((r) => r.run !== null);
  if (runs.length === 0) return Object.keys(state.runs)[0] ?? null;
  const newest = (xs: RunView[]) =>
    xs.sort((a, b) => Date.parse(b.run!.updatedAt) - Date.parse(a.run!.updatedAt))[0]!.runId;
  const active = runs.filter(isActive);
  return newest(active.length > 0 ? active : runs);
}

// ---------------------------------------------------------------------------
// Usage

export interface UsageSeries {
  key: string;
  vendor: Vendor;
  account: string;
  window: TimedUsageSample["window"];
  points: Array<{ time: number; utilization: number; source: UsageSource }>;
  /** True when the latest reading is an estimate rather than the vendor's own figure. */
  estimated: boolean;
  /**
   * The ceiling as a utilization share: `max`, or 1 for a spend ceiling.
   * `null` when the vendor's ceiling applies to another window.
   */
  ceiling: number | null;
  resetAt: number | null;
  /** When the series reaches its ceiling; `null` when it won't before the reset. */
  forecastAt: number | null;
  /** True when the forecast came from the server; false when computed here. */
  serverForecast: boolean;
}

export interface VendorUsageInfo {
  vendor: Vendor;
  account: string;
  window: TimedUsageSample["window"];
  forecastAt: string | null;
  resetAt: string | null;
}

/** How the dashboard names where a usage reading came from. */
export const USAGE_SOURCE_LABELS: Record<UsageSource, string> = {
  rate_limit_event: "reported by Claude",
  codex_session: "reported by Codex",
  codex_tokens: "estimated from Codex tokens",
  billing_api: "billing API",
  estimate: "estimate",
};

/** True for a reading the server estimated instead of reading from the vendor. */
export function isEstimatedSource(source: UsageSource): boolean {
  return source === "codex_tokens" || source === "estimate";
}

/**
 * The ceiling of a sample as a share of the vendor's limit, or `null` when
 * the ceiling governs another window: a 5-hour ceiling says nothing about
 * the 7-day window, and a monthly spend ceiling nothing about either.
 */
export function ceilingShare(sample: TimedUsageSample): number | null {
  if (sample.ceiling.kind === "utilization") {
    return sample.ceiling.window === sample.window ? sample.ceiling.max : null;
  }
  return sample.window === "month" ? 1 : null;
}

/**
 * A local forecast for when the series reaches its ceiling, by a straight line
 * through the samples since the last drop (a window reset). Returns `null`
 * when usage is flat or falling, or the line crosses only after `resetAt`.
 */
export function linearForecast(
  points: ReadonlyArray<{ time: number; utilization: number }>,
  ceiling: number,
  resetAt: number | null,
): number | null {
  let start = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i]!.utilization < points[i - 1]!.utilization) start = i;
  }
  const seg = points.slice(start);
  if (seg.length < 2) return null;
  const first = seg[0]!;
  const last = seg[seg.length - 1]!;
  if (last.utilization >= ceiling) return last.time;
  const rate = (last.utilization - first.utilization) / (last.time - first.time);
  if (!(rate > 0)) return null;
  const at = last.time + (ceiling - last.utilization) / rate;
  if (resetAt !== null && at > resetAt) return null;
  return Math.round(at);
}

/**
 * One series per vendor account and window, in vendor order. The server's
 * forecast and reset time win where `info` has them.
 */
export function usageSeries(
  state: DashboardState,
  info: readonly VendorUsageInfo[] = [],
): UsageSeries[] {
  const series: UsageSeries[] = [];
  for (const [key, samples] of Object.entries(state.usage)) {
    const last = samples[samples.length - 1];
    if (!last) continue;
    const points = samples.map((s) => ({
      time: Date.parse(s.time),
      utilization: s.utilization,
      source: s.sampleSource,
    }));
    const ceiling = ceilingShare(last);
    const server = info.find(
      (i) => i.vendor === last.vendor && i.account === last.account && i.window === last.window,
    );
    const resetIso = server?.resetAt ?? last.resetAt;
    const resetAt = resetIso ? Date.parse(resetIso) : null;
    const forecast =
      ceiling === null
        ? null
        : server
          ? server.forecastAt
            ? Date.parse(server.forecastAt)
            : null
          : linearForecast(points, ceiling, resetAt);
    series.push({
      key,
      vendor: last.vendor,
      account: last.account,
      window: last.window,
      points,
      estimated: isEstimatedSource(last.sampleSource),
      ceiling,
      resetAt,
      forecastAt: forecast,
      serverForecast: server !== undefined,
    });
  }
  return series.sort(
    (a, b) =>
      VENDORS.indexOf(a.vendor) - VENDORS.indexOf(b.vendor) ||
      a.account.localeCompare(b.account) ||
      a.window.localeCompare(b.window),
  );
}

// ---------------------------------------------------------------------------
// Formatting

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return "–";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

/** Compacts a count: 1,284 stays, 12,900 becomes 12.9K. */
export function formatCount(n: number): string {
  if (n < 10_000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatUsd(n: number): string {
  return n < 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(0)}`;
}

export function formatPercent(n: number): string {
  return `${Math.round(n * 100)}%`;
}
