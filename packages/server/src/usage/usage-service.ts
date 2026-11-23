// Account-wide usage: ingests `usage.sample` and `lease.settled` events from
// every engine, compares each vendor against its ceiling, emits
// `ceiling.crossed`, and forecasts when a vendor reaches its ceiling.
import {
  PlatformSchema,
  type AioEvent,
  type Ceiling,
  type Ceilings,
  type CeilingsOverride,
  type GlobalSettings,
  type TimedUsageSample,
  type UsageWindow,
  type Vendor,
  type VendorUsageSchema,
} from "@aio/contracts";
import type { z } from "zod";
import type { EventInput } from "../api/core-interface.js";
import type { UsageStore } from "./usage-store.js";

export type VendorUsage = z.infer<typeof VendorUsageSchema>;

/** Every vendor, in the order `usage.get` lists them. */
export const VENDORS: readonly Vendor[] = PlatformSchema.options;

/** How far back the forecast looks. */
export const FORECAST_SPAN_MS = 60 * 60 * 1000;

/** The usage window a ceiling compares against. */
export function ceilingWindow(ceiling: Ceiling): UsageWindow {
  return ceiling.kind === "utilization" ? ceiling.window : "month";
}

/** A sample's value on the ceiling's scale, and the value at which the ceiling is reached. */
function scale(sample: TimedUsageSample, ceiling: Ceiling): { value: number; limit: number } {
  if (ceiling.kind === "utilization") return { value: sample.utilization, limit: ceiling.max };
  return { value: sample.spendUsd ?? sample.utilization * ceiling.maxUsd, limit: ceiling.maxUsd };
}

/** The value at which the ceiling is reached, on the ceiling's own scale. */
export function ceilingLimit(ceiling: Ceiling): number {
  return ceiling.kind === "utilization" ? ceiling.max : ceiling.maxUsd;
}

/**
 * Whether a sample is at or over its ceiling. A sample whose `resetAt` has
 * passed counts as reset, so it is never over, except against a ceiling of
 * zero, which is a choice not to use the vendor at all.
 */
export function sampleIsOver(sample: TimedUsageSample, ceiling: Ceiling, nowMs: number): boolean {
  if (sample.window !== ceilingWindow(ceiling)) return false;
  if (ceilingLimit(ceiling) > 0 && sample.resetAt !== null && Date.parse(sample.resetAt) <= nowMs)
    return false;
  const { value, limit } = scale(sample, ceiling);
  return value >= limit;
}

/**
 * The label to store a sample under. An engine that doesn't know accounts
 * yet labels its samples with a legacy name (the Claude email,
 * `codex-default`, `copilot-default`); once the vendor has a default
 * account, such a sample counts against that account, as seeding relabeled
 * the history. An account id (`VENDOR/NAME`) stays as it is.
 */
export function accountLabel(
  vendor: Vendor,
  label: string,
  settings: Pick<GlobalSettings, "accountDefaults">,
): string {
  if (label.includes("/")) return label;
  return settings.accountDefaults[vendor] ?? label;
}

export interface OverState {
  over: boolean;
  resetAt: string | null;
  utilization: number | null;
}

export interface UsageServiceOptions {
  store: UsageStore;
  settings: () => GlobalSettings;
  emit: (event: EventInput) => AioEvent;
  now?: () => Date;
}

export class UsageService {
  /** Over or not, per `vendor|account|window`, as of the last sample ingested. */
  private readonly state = new Map<string, boolean>();

  constructor(private readonly opts: UsageServiceOptions) {}

  private nowMs(): number {
    return (this.opts.now?.() ?? new Date()).getTime();
  }

  /** Handles `usage.sample` and `lease.settled`; ignores every other event. */
  ingest(event: AioEvent): void {
    if (event.type === "lease.settled") {
      this.opts.store.recordSettlement(
        {
          leaseId: event.leaseId,
          runId: event.runId,
          ...(event.buildId === undefined ? {} : { buildId: event.buildId }),
          ...(event.seat === undefined ? {} : { seat: event.seat }),
          ...(event.step === undefined ? {} : { step: event.step }),
          vendor: event.vendor,
          role: event.role,
          tokens: event.tokens,
          premiumRequests: event.premiumRequests,
          costEstimate: event.costEstimate,
        },
        event.time,
      );
      return;
    }
    if (event.type !== "usage.sample") return;
    this.recordSample({
      vendor: event.vendor,
      account: accountLabel(event.vendor, event.account, this.opts.settings()),
      window: event.window,
      utilization: event.utilization,
      spendUsd: event.spendUsd,
      ceiling: event.ceiling,
      resetAt: event.resetAt,
      sampleSource: event.sampleSource,
      time: event.time,
    });
  }

  /** Stores a sample and emits `ceiling.crossed` when it moves the vendor across its ceiling. */
  private recordSample(sample: TimedUsageSample): void {
    const ceiling = this.opts.settings().ceilings[sample.vendor];
    const key = `${sample.vendor}|${sample.account}|${sample.window}`;
    const now = this.nowMs();
    let before = this.state.get(key);
    if (before === undefined) {
      const previous = this.opts.store.latest(sample.vendor, sample.window, sample.account);
      before = previous ? sampleIsOver(previous, ceiling, now) : false;
    }
    this.opts.store.record(sample);
    if (sample.window !== ceilingWindow(ceiling)) return;
    const after = sampleIsOver(sample, ceiling, now);
    this.state.set(key, after);
    if (after === before) return;
    this.opts.emit({
      type: "ceiling.crossed",
      vendor: sample.vendor,
      account: sample.account,
      window: sample.window,
      utilization: sample.utilization,
      ceiling,
      direction: after ? "above" : "below",
      resetAt: sample.resetAt,
    });
  }

  /**
   * Clears a stale block: for each of the vendor's accounts, or the one named,
   * records a zero reading in every window where the newest sample is over the
   * global ceiling or a project's override, as the scheduler blocks on either.
   * A stored sample can say 100% until its old reset time even after a person
   * buys a reset, and a blocked vendor gets no call that could correct it. The
   * vendor's next real sample replaces this one. A ceiling of zero is a choice
   * not to use the vendor, not a stale sample, so it clears nothing. Returns how
   * many samples it cleared.
   */
  clear(vendor: Vendor, account?: string, overrides: readonly CeilingsOverride[] = []): number {
    const ceilings = [
      this.opts.settings().ceilings[vendor],
      ...overrides.flatMap((o) => o[vendor] ?? []),
    ].filter((c) => ceilingLimit(c) > 0);
    const windows = new Set(ceilings.map(ceilingWindow));
    let cleared = 0;
    for (const name of account === undefined ? this.opts.store.accounts(vendor) : [account]) {
      for (const window of windows) {
        const latest = this.opts.store.latest(vendor, window, name);
        if (!latest || !ceilings.some((c) => sampleIsOver(latest, c, this.nowMs()))) continue;
        this.recordSample({
          ...latest,
          utilization: 0,
          spendUsd: latest.spendUsd === null ? null : 0,
          sampleSource: "manual_clear",
          time: new Date(this.nowMs()).toISOString(),
        });
        cleared += 1;
      }
    }
    return cleared;
  }

  /**
   * Compares the vendor's newest sample in the ceiling's window against the
   * ceiling. With no account, the vendor is over when any of its accounts is
   * over: a lease request doesn't name its account, and the newest sample
   * across accounts would depend on which account sampled last.
   */
  isOver(vendor: Vendor, ceilings: Ceilings, account?: string): OverState {
    if (account === undefined) {
      const states = this.opts.store.accounts(vendor).map((a) => this.isOver(vendor, ceilings, a));
      const over = states.filter((s) => s.over);
      if (over.length > 0) {
        // The vendor is usable again once every over account has reset; an
        // unknown reset time keeps the whole answer unknown.
        const resets = over.map((s) => s.resetAt);
        const resetAt = resets.includes(null)
          ? null
          : (resets as string[]).reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
        const utilization = Math.max(...over.map((s) => s.utilization ?? 0));
        return { over: true, resetAt, utilization };
      }
      if (states.length > 0) {
        return states.reduce((a, b) => ((b.utilization ?? -1) > (a.utilization ?? -1) ? b : a));
      }
    }
    const ceiling = ceilings[vendor];
    const latest = this.opts.store.latest(vendor, ceilingWindow(ceiling), account);
    // With no sample the usage is unknown, which counts as under a ceiling
    // above zero; a ceiling of zero means "don't use this vendor".
    if (!latest) return { over: ceilingLimit(ceiling) <= 0, resetAt: null, utilization: null };
    return {
      over: sampleIsOver(latest, ceiling, this.nowMs()),
      resetAt: latest.resetAt,
      utilization: latest.utilization,
    };
  }

  /**
   * When the vendor reaches its ceiling at the current rate: a least-squares
   * line through the last hour of samples in the current reset period.
   * Returns `null` when it is already over, usage is not rising, or the
   * window resets first.
   */
  forecast(vendor: Vendor, ceilings: Ceilings, account?: string): string | null {
    const ceiling = ceilings[vendor];
    const window = ceilingWindow(ceiling);
    const latest = this.opts.store.latest(vendor, window, account);
    if (!latest) return null;
    const now = this.nowMs();
    if (sampleIsOver(latest, ceiling, now)) return null;
    const samples = this.opts.store
      .recent(vendor, window, latest.account, now - FORECAST_SPAN_MS)
      .filter((s) => s.resetAt === latest.resetAt);
    if (samples.length < 2) return null;
    const points = samples.map((s) => ({ t: Date.parse(s.time), v: scale(s, ceiling).value }));
    const n = points.length;
    const tMean = points.reduce((a, p) => a + p.t, 0) / n;
    const vMean = points.reduce((a, p) => a + p.v, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of points) {
      num += (p.t - tMean) * (p.v - vMean);
      den += (p.t - tMean) ** 2;
    }
    if (den === 0) return null;
    const slope = num / den;
    if (slope <= 0) return null;
    const { limit } = scale(latest, ceiling);
    const reachedAt = Math.max(now, tMean + (limit - vMean) / slope);
    if (latest.resetAt !== null && reachedAt > Date.parse(latest.resetAt)) return null;
    return new Date(Math.round(reachedAt)).toISOString();
  }

  /** Usage per vendor and account against the global ceilings: the body of `usage.get`. */
  vendors(): VendorUsage[] {
    const ceilings = this.opts.settings().ceilings;
    const result: VendorUsage[] = [];
    for (const vendor of VENDORS) {
      const ceiling = ceilings[vendor];
      const window = ceilingWindow(ceiling);
      const accounts = this.opts.store.accounts(vendor);
      for (const account of accounts.length ? accounts : [""]) {
        const latest = (["5h", "7d", "month"] as const)
          .map((w) => this.opts.store.latest(vendor, w, account))
          .filter((s): s is TimedUsageSample => s !== undefined);
        const state = accounts.length
          ? this.isOver(vendor, ceilings, account)
          : { over: false, resetAt: null };
        result.push({
          vendor,
          account,
          ceiling,
          latest,
          overCeiling: state.over,
          forecastAt: accounts.length ? this.forecast(vendor, ceilings, account) : null,
          resetAt: state.resetAt,
          window,
        });
      }
    }
    return result;
  }
}
