// The usage watcher: an account-wide check over builds and stand-alone
// review runs. It alerts when a window nears its limit at the current burn
// rate, on an abnormal jump, and when a build passes a multiple of its usage
// estimate. It only alerts: nothing pauses because of it.
import {
  WATCHED_WINDOWS,
  usageWatchOf,
  type AioEvent,
  type BuildSummary,
  type EventOf,
  type GlobalSettings,
  type TimedUsageSample,
  type UsageWatchWindow,
  type Vendor,
  type WatchedWindow,
} from "@aio/contracts";
import { FORECAST_SPAN_MS, accountLabel } from "./usage-service.js";
import type { UsageStore } from "./usage-store.js";

/** Build statuses whose Project manager still acts on alerts. */
const ACTIVE_BUILD_STATUSES: ReadonlySet<BuildSummary["status"]> = new Set([
  "planning",
  "running",
  "paused",
  "waiting_escalation",
]);

/** One alert, for the desktop and the Project manager. */
export interface UsageAlert {
  /** `ceiling`: near the limit at the burn rate; `jump`: an abnormal rise; `build_estimate`: past the estimate. */
  rule: "ceiling" | "jump" | "build_estimate";
  title: string;
  body: string;
  /** The vendor and window of a window alert; `null` for a build alert. */
  vendor: Vendor | null;
  account: string | null;
  window: WatchedWindow | null;
  /** The build of a build alert; `null` for a window alert. */
  buildId: string | null;
  /** The box whose Project manager runs the build, for a build alert. */
  boxId: string | null;
}

export interface UsageWatcherOptions {
  /** The store the usage service records into; it must ingest each event first. */
  store: UsageStore;
  settings: () => GlobalSettings;
  /** The mirrored build, for its usage estimate and box. */
  build: (buildId: string) => BuildSummary | undefined;
  /** Whether a build already got its estimate alert, such as before a restart. */
  alerted: (buildId: string) => boolean;
  alert: (alert: UsageAlert) => void;
}

/** Which rules hold at a sample. */
interface Crossing {
  ceiling: boolean;
  jump: boolean;
}

const VENDOR_NAMES: Record<Vendor, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
};

const WINDOW_NAMES: Record<WatchedWindow, string> = { "5h": "5-hour", "7d": "7-day" };

const percent = (share: number) => `${Math.round(share * 100)}%`;

function isWatched(window: string): window is WatchedWindow {
  return (WATCHED_WINDOWS as readonly string[]).includes(window);
}

/**
 * Which rules hold at `latest`, given the samples of the same reset period
 * up to it, oldest first. The ceiling rule holds when usage is at or past
 * `ceilingAt` and the burn rate over the last hour reaches the whole window
 * before it resets. The jump rule holds when usage rose by more than `jump`
 * since the lowest sample of the last `jumpMinutes`.
 */
export function crossingAt(
  latest: TimedUsageSample,
  history: readonly TimedUsageSample[],
  rules: UsageWatchWindow,
): Crossing {
  const at = Date.parse(latest.time);
  const period = history.filter((s) => s.resetAt === latest.resetAt && Date.parse(s.time) <= at);
  const u = latest.utilization;

  let ceiling = false;
  if (u >= rules.ceilingAt) {
    if (u >= 1) ceiling = true;
    else {
      const span = period.filter((s) => Date.parse(s.time) >= at - FORECAST_SPAN_MS);
      const first = span[0];
      const dt = first ? at - Date.parse(first.time) : 0;
      const rate = first && dt > 0 ? (u - first.utilization) / dt : 0;
      if (rate > 0) {
        const left = latest.resetAt === null ? Infinity : Date.parse(latest.resetAt) - at;
        ceiling = u + rate * left >= 1;
      }
    }
  }

  const recent = period.filter((s) => Date.parse(s.time) >= at - rules.jumpMinutes * 60_000);
  const lowest = Math.min(u, ...recent.map((s) => s.utilization));
  const jump = u - lowest > rules.jump;
  return { ceiling, jump };
}

export class UsageWatcher {
  /** The rules that held at the last sample, per `vendor|account|window`. */
  private readonly state = new Map<string, Crossing>();
  /** Builds that got their estimate alert since the server started. */
  private readonly overEstimate = new Set<string>();

  constructor(private readonly opts: UsageWatcherOptions) {}

  /** Handles `usage.sample` and `lease.settled`; ignores every other event. */
  ingest(event: AioEvent): void {
    if (event.type === "usage.sample") this.onSample(event);
    else if (event.type === "lease.settled" && event.buildId !== undefined)
      this.onBuildUsage(event.buildId);
  }

  private onSample(event: EventOf<"usage.sample">): void {
    const window = event.window;
    if (!isWatched(window)) return;
    const settings = this.opts.settings();
    const rules = usageWatchOf(settings)[window];
    const vendor = event.vendor;
    const account = accountLabel(vendor, event.account, settings);
    const at = Date.parse(event.time);
    // Twice the longest span the rules look back over, so the sample before
    // this one has its own full history for the restart check below.
    const lookback = Math.max(FORECAST_SPAN_MS, rules.jumpMinutes * 60_000);
    const history = this.opts.store.recent(vendor, window, account, at - 2 * lookback);
    const latest: TimedUsageSample = {
      vendor,
      account,
      window,
      utilization: event.utilization,
      spendUsd: event.spendUsd,
      ceiling: event.ceiling,
      resetAt: event.resetAt,
      sampleSource: event.sampleSource,
      time: event.time,
    };
    const key = `${vendor}|${account}|${window}`;
    let before = this.state.get(key);
    if (before === undefined) {
      // After a restart, the sample before this one says what was already reported.
      const earlier = history.filter((s) => Date.parse(s.time) < at);
      const previous = earlier[earlier.length - 1];
      before = previous ? crossingAt(previous, earlier, rules) : { ceiling: false, jump: false };
    }
    const after = crossingAt(latest, history, rules);
    this.state.set(key, after);

    const who = `${VENDOR_NAMES[vendor]} (${account})`;
    const span = WINDOW_NAMES[window];
    const resets =
      event.resetAt === null ? "" : ` The window resets at ${event.resetAt.slice(0, 16)}Z.`;
    const base = { vendor, account, window, buildId: null, boxId: null };
    if (after.ceiling && !before.ceiling) {
      this.opts.alert({
        ...base,
        rule: "ceiling",
        title: `${VENDOR_NAMES[vendor]} ${span} usage is at ${percent(event.utilization)}`,
        body: `${who} is past ${percent(rules.ceilingAt)} of its ${span} window, and at the current rate it reaches the limit before the window resets.${resets}`,
      });
    }
    if (after.jump && !before.jump) {
      this.opts.alert({
        ...base,
        rule: "jump",
        title: `${VENDOR_NAMES[vendor]} ${span} usage jumped`,
        body: `${who} used more than ${percent(rules.jump)} of its ${span} window in ${rules.jumpMinutes} minutes and is at ${percent(event.utilization)}.${resets}`,
      });
    }
  }

  private onBuildUsage(buildId: string): void {
    if (this.overEstimate.has(buildId)) return;
    const build = this.opts.build(buildId);
    const estimate = build?.usageEstimate;
    if (!build || !estimate) return;
    const factor = usageWatchOf(this.opts.settings()).buildEstimateFactor;
    const total = this.opts.store.buildUsage(buildId).total;
    const used = total.tokensIn + total.tokensOut;
    if (used <= estimate.high * factor) return;
    this.overEstimate.add(buildId);
    if (this.opts.alerted(buildId)) return;
    this.opts.alert({
      rule: "build_estimate",
      title: `Build ${build.slug} passed ${factor} times its usage estimate`,
      body: `The build ${build.slug} used ${used.toLocaleString("en-US")} tokens against an estimate of ${estimate.low.toLocaleString("en-US")} to ${estimate.high.toLocaleString("en-US")}.`,
      vendor: null,
      account: null,
      window: null,
      buildId,
      boxId: build.boxId,
    });
  }
}

/**
 * The boxes whose Project manager gets an alert: a build alert goes to its
 * build's box, and a window alert to the box of every active build, since
 * the window is account-wide.
 */
export function projectManagerBoxes(alert: UsageAlert, builds: readonly BuildSummary[]): string[] {
  if (alert.buildId !== null) return alert.boxId === null ? [] : [alert.boxId];
  const boxes = builds
    .filter((b) => ACTIVE_BUILD_STATUSES.has(b.status))
    .flatMap((b) => (b.boxId === null ? [] : [b.boxId]));
  return [...new Set(boxes)];
}

/**
 * The alert as one line for the Project manager's session, since the server
 * types it into the box's terminal. The owner decides whether to pause.
 */
export function projectManagerMessage(alert: UsageAlert): string {
  const text = `Usage alert: ${alert.title}. ${alert.body}`.replace(/\s+/g, " ").trim();
  return `${text} Report this to the owner, who decides whether to pause or continue; nothing pauses on its own.`;
}
