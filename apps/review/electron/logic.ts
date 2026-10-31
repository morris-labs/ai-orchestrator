// The Electron main process's decisions, kept free of Electron so the tests
// run in Node: deep links, the renderer URL, the active-run count, which
// notifications to show, and the tray bitmap.
import { ACTIVE_STATUSES_FOR_TRAY, type DeepLink } from "./types.js";
import type { AgentBoxEvent, NotificationToggles, RunState } from "@agentbox/contracts";

export { ACTIVE_STATUSES_FOR_TRAY, type DeepLink };

/** The URL scheme the app registers, as in `agentbox-review://launch?project=ID&box=ID`. */
export const PROTOCOL = "agentbox-review";

/**
 * Finds a deep link in a command line: an `agentbox-review://` URL, a bare
 * query such as `?project=ID&box=ID`, or `--project=ID` and `--box=ID`
 * flags. Returns `null` when there is none.
 */
export function parseDeepLink(argv: readonly string[]): DeepLink | null {
  let project: string | null = null;
  let box: string | null = null;
  for (const arg of argv) {
    let query: string | null = null;
    if (arg.startsWith(`${PROTOCOL}:`)) {
      const i = arg.indexOf("?");
      query = i >= 0 ? arg.slice(i + 1) : "";
    } else if (arg.startsWith("?")) {
      query = arg.slice(1);
    } else if (arg.startsWith("--project=")) {
      project = arg.slice("--project=".length) || null;
    } else if (arg.startsWith("--box=")) {
      box = arg.slice("--box=".length) || null;
    }
    if (query !== null) {
      const q = new URLSearchParams(query);
      project = q.get("project") ?? project;
      box = q.get("box") ?? box;
    }
  }
  return project || box ? { project, box } : null;
}

/** The renderer's URL on the server, with the deep link as its query. */
export function rendererUrl(serverUrl: string, link: DeepLink | null): string {
  const base = `${serverUrl.replace(/\/$/, "")}/review/`;
  if (!link) return base;
  const q = new URLSearchParams();
  if (link.project) q.set("project", link.project);
  if (link.box) q.set("box", link.box);
  return `${base}?${q.toString()}#/launch`;
}

/** The hash that opens the launcher prefilled, for a window that is already open. */
export function launcherHash(link: DeepLink): string {
  const q = new URLSearchParams();
  if (link.project) q.set("project", link.project);
  if (link.box) q.set("box", link.box);
  return `#/launch?${q.toString()}`;
}

/** Tracks which runs are active, from `runs.list` and `run.changed` events. */
export class ActiveRuns {
  private readonly active = new Set<string>();
  /** Counts applied events. */
  private version = 0;
  /** The `version` at which an event last changed each run. */
  private readonly changedAt = new Map<string, number>();

  /** The position to pass to `seed` for a `runs.list` call that starts now. */
  mark(): number {
    return this.version;
  }

  /**
   * Replaces the active set with a `runs.list` result. A run that an event
   * changed after `since`, the `mark()` taken when the call started, keeps
   * what the event said, because the list may predate it.
   */
  seed(runs: readonly RunState[], since: number = this.version): void {
    const newer = new Map<string, boolean>();
    for (const [id, at] of this.changedAt) {
      if (at > since) newer.set(id, this.active.has(id));
      else this.changedAt.delete(id);
    }
    this.active.clear();
    for (const r of runs) if (ACTIVE_STATUSES_FOR_TRAY.includes(r.status)) this.active.add(r.id);
    for (const [id, isActive] of newer) {
      if (isActive) this.active.add(id);
      else this.active.delete(id);
    }
  }

  /** Returns true when the count changed. */
  apply(event: AgentBoxEvent): boolean {
    if (event.type !== "run.changed") return false;
    this.version += 1;
    this.changedAt.set(event.run.id, this.version);
    const before = this.active.size;
    if (ACTIVE_STATUSES_FOR_TRAY.includes(event.run.status)) this.active.add(event.run.id);
    else this.active.delete(event.run.id);
    return before !== this.active.size;
  }

  get count(): number {
    return this.active.size;
  }
}

export interface DesktopNotice {
  notificationId: string;
  title: string;
  body: string;
  /** The renderer hash to open on click. */
  hash: string;
  urgent: boolean;
}

/**
 * How old a notification can be and still pop up. A reconnect replays every
 * event the app missed; older notifications stay in the app's list but don't
 * pop up all at once.
 */
export const STALE_NOTICE_MS = 10 * 60 * 1000;

/**
 * The desktop notification for a server `notification` event, or `null` when
 * this app doesn't show its kind, the person turned the kind off, or, with
 * `now`, the event is older than `STALE_NOTICE_MS`. Box notifications belong
 * to the boxes app.
 */
export function noticeFor(
  event: AgentBoxEvent,
  toggles: NotificationToggles,
  now?: number,
): DesktopNotice | null {
  if (event.type !== "notification" || event.read) return null;
  if (now !== undefined && now - Date.parse(event.time) > STALE_NOTICE_MS) return null;
  const toggle: Record<string, keyof NotificationToggles> = {
    decision_needed: "decisionNeeded",
    run_finished: "runFinished",
    ready_to_push: "readyToPush",
    round_summary: "roundSummary",
  };
  const key = toggle[event.kind];
  if (!key || !toggles[key]) return null;
  return {
    notificationId: event.notificationId,
    title: event.title,
    body: event.body,
    hash: event.runId ? `#/runs/${event.runId}` : "#/runs",
    urgent: event.kind === "decision_needed",
  };
}

export interface RetryTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const REAL_TIMERS: RetryTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Runs a REST reload, and runs it again with backoff while it fails. A new
 * `request()` replaces a reload waiting to run again; `stop()` ends it.
 */
export class Reloader {
  private generation = 0;
  private attempt = 0;
  private timer: unknown = null;
  private stopped = false;

  constructor(
    private readonly load: () => Promise<void>,
    private readonly timers: RetryTimers = REAL_TIMERS,
    private readonly initialMs = 2000,
    private readonly maxMs = 60_000,
  ) {}

  request(): void {
    this.stopped = false;
    this.attempt = 0;
    this.run();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.clearTimer();
  }

  private run(): void {
    this.clearTimer();
    const generation = ++this.generation;
    this.load().then(
      () => undefined,
      () => {
        if (this.stopped || generation !== this.generation) return;
        const delay = Math.min(this.maxMs, this.initialMs * 2 ** this.attempt);
        this.attempt += 1;
        this.timer = this.timers.set(() => {
          this.timer = null;
          this.run();
        }, delay);
      },
    );
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}

export function trayTooltip(count: number): string {
  if (count === 0) return "Agent Box Review: no active runs";
  return `Agent Box Review: ${count} active ${count === 1 ? "run" : "runs"}`;
}

// 3x5 digit glyphs, one row per string, for the tray badge.
const DIGITS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
};

/**
 * A square BGRA bitmap for the tray: a ring in the accent color, filled when
 * runs are active, with the count drawn in white (9 and up shows `9+`).
 * Electron reads it with `nativeImage.createFromBitmap`.
 */
export function trayBitmap(count: number, size = 32): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const accent = [0xe5, 0x87, 0x39]; // #3987e5 as B, G, R
  const c = (size - 1) / 2;
  const outer = size / 2 - 1;
  const inner = outer - Math.max(2, Math.round(size / 10));
  const set = (x: number, y: number, bgr: number[], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = bgr[0]!;
    buf[i + 1] = bgr[1]!;
    buf[i + 2] = bgr[2]!;
    buf[i + 3] = a;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const d = Math.hypot(x - c, y - c);
      if (d <= outer && (count > 0 || d >= inner)) set(x, y, accent);
    }
  }
  if (count > 0) {
    const text = count > 9 ? "9+" : String(count);
    const scale = Math.max(1, Math.floor(size / 10));
    const w = text.length * 3 * scale + (text.length - 1) * scale;
    const h = 5 * scale;
    const x0 = Math.round((size - w) / 2);
    const y0 = Math.round((size - h) / 2);
    [...text].forEach((ch, n) => {
      const glyph = DIGITS[ch]!;
      glyph.forEach((row, gy) => {
        [...row].forEach((bit, gx) => {
          if (bit !== "1") return;
          for (let sy = 0; sy < scale; sy += 1)
            for (let sx = 0; sx < scale; sx += 1)
              set(x0 + (n * 4 + gx) * scale + sx, y0 + gy * scale + sy, [255, 255, 255]);
        });
      });
    });
  }
  return buf;
}
