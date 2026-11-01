// The Electron main process's decisions, kept free of Electron so the tests
// run in Node: deep links, the renderer URL, the active-run count on every
// machine, which notifications to show, and the tray bitmap.
import { ACTIVE_STATUSES_FOR_TRAY, type DeepLink } from "./types.js";
import type { AioEvent, Machine, NotificationToggles, RunState } from "@aio/contracts";

export { ACTIVE_STATUSES_FOR_TRAY, type DeepLink };

/**
 * The URL scheme the app registers, as in
 * `aio-review://launch?project=ID&box=ID&machine=ID`.
 */
export const PROTOCOL = "aio-review";

/**
 * Finds a deep link in a command line: an `aio-review://` URL, a bare
 * query such as `?project=ID&box=ID`, or `--project=ID`, `--box=ID`, and
 * `--machine=ID` flags. Returns `null` when there is none; a machine alone
 * isn't a link.
 */
export function parseDeepLink(argv: readonly string[]): DeepLink | null {
  let project: string | null = null;
  let box: string | null = null;
  let machine: string | null = null;
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
    } else if (arg.startsWith("--machine=")) {
      machine = arg.slice("--machine=".length) || null;
    }
    if (query !== null) {
      const q = new URLSearchParams(query);
      project = q.get("project") ?? project;
      box = q.get("box") ?? box;
      machine = q.get("machine") || machine;
    }
  }
  return project || box ? { project, box, machine } : null;
}

/** The deep link's query: `project`, `box`, and `machine`, each when set. */
function linkQuery(link: DeepLink): string {
  const q = new URLSearchParams();
  if (link.project) q.set("project", link.project);
  if (link.box) q.set("box", link.box);
  if (link.machine) q.set("machine", link.machine);
  return q.toString();
}

/** The renderer's URL on the server, with the deep link as its query. */
export function rendererUrl(serverUrl: string, link: DeepLink | null): string {
  const base = `${serverUrl.replace(/\/$/, "")}/review/`;
  if (!link) return base;
  return `${base}?${linkQuery(link)}#/launch`;
}

/** The hash that opens the launcher prefilled, for a window that is already open. */
export function launcherHash(link: DeepLink): string {
  return `#/launch?${linkQuery(link)}`;
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
  apply(event: AioEvent): boolean {
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

/** The machine a notification comes from, for its title and its link. */
export interface NoticeMachine {
  id: string;
  name: string;
  isLocal: boolean;
}

/**
 * The desktop notification for a server `notification` event, or `null` when
 * this app doesn't show its kind, the person turned the kind off, or, with
 * `now`, the event is older than `STALE_NOTICE_MS`. Box notifications belong
 * to the boxes app. With `machine`, the title names the machine, and for
 * another machine the link opens the run on it.
 */
export function noticeFor(
  event: AioEvent,
  toggles: NotificationToggles,
  now?: number,
  machine?: NoticeMachine,
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
  const hash = event.runId ? `#/runs/${event.runId}` : "#/runs";
  return {
    notificationId: event.notificationId,
    title: machine ? `${machine.name}: ${event.title}` : event.title,
    body: event.body,
    hash: machine && !machine.isLocal ? `${hash}?machine=${encodeURIComponent(machine.id)}` : hash,
    urgent: event.kind === "decision_needed",
  };
}

/** How often the app reloads the machine list. */
export const MACHINE_POLL_MS = 10_000;

/** The handlers a machine's event stream calls. */
export interface MachineStreamHandlers {
  onEvent: (event: AioEvent) => void;
  /** The machine can't replay what the stream missed: reload its runs. */
  onResync: () => void;
}

/** What `FleetActiveRuns` needs from the outside world, so tests can fake it. */
export interface FleetDeps {
  /** This server's machine list; rejects with a 404 on a server without machine routes. */
  listMachines: () => Promise<Machine[]>;
  /** `runs.list` on another machine, through the hub. */
  listRuns: (machineId: string) => Promise<RunState[]>;
  /** Opens another machine's event stream through the hub. */
  connect: (machineId: string, handlers: MachineStreamHandlers) => { stop: () => void };
  /** The active-run count changed. */
  onCount: () => void;
  /** Another machine sent a `notification` event. */
  onNotification: (machine: NoticeMachine, event: AioEvent) => void;
  timers?: RetryTimers;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  pollMs?: number;
}

/** One other machine that the app follows while it's online. */
interface Followed {
  machine: NoticeMachine;
  runs: ActiveRuns;
  stream: { stop: () => void };
  reloader: Reloader;
}

/** True when an error is an HTTP status that means the server has no machine routes. */
function noMachineRoutes(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && [404, 405, 501].includes(status);
}

/**
 * The active runs of this machine and of every other online machine, for
 * the tray, and the notifications of the other machines. It polls the
 * machine list, and follows each online machine's event stream through the
 * hub while the machine stays online. A machine that goes offline or is
 * revoked stops counting at once: its runs show only while it's online.
 */
export class FleetActiveRuns {
  /** This machine's runs, which the app's own event stream keeps current. */
  readonly local = new ActiveRuns();
  private localMachine: NoticeMachine | null = null;
  private readonly followed = new Map<string, Followed>();
  private timer: unknown = null;
  private polls = 0;
  private stopped = false;

  constructor(private readonly deps: FleetDeps) {}

  /** The active runs on every followed machine, this one included. */
  get count(): number {
    let n = this.local.count;
    for (const f of this.followed.values()) n += f.runs.count;
    return n;
  }

  /** The IDs of the other machines the app follows. */
  get machineIds(): string[] {
    return [...this.followed.keys()];
  }

  /**
   * This machine, for a notice's title, while the app follows another
   * machine; `undefined` on a single machine, whose notices stay as they were.
   */
  localNoticeMachine(): NoticeMachine | undefined {
    return this.followed.size > 0 && this.localMachine ? this.localMachine : undefined;
  }

  /** Reloads the machine list, then follows the online machines and drops the rest. */
  async refresh(): Promise<void> {
    const poll = ++this.polls;
    let machines: Machine[];
    try {
      machines = await this.deps.listMachines();
    } catch (err) {
      if (poll !== this.polls || this.stopped) return;
      // A server without machine routes is a single machine: stop asking.
      if (noMachineRoutes(err)) this.stopPolling();
      // Otherwise keep the machines as they are until a list comes back.
      return;
    }
    if (poll !== this.polls || this.stopped) return;
    const local = machines.find((m) => m.isLocal);
    this.localMachine = local ? { id: local.id, name: local.name, isLocal: true } : null;
    const online = new Map(
      machines.filter((m) => !m.isLocal && m.status === "online").map((m) => [m.id, m]),
    );
    let changed = false;
    for (const [id, f] of this.followed) {
      if (online.has(id)) {
        f.machine = { ...f.machine, name: online.get(id)!.name };
        continue;
      }
      changed ||= f.runs.count > 0;
      this.unfollow(id);
    }
    for (const m of online.values()) {
      if (!this.followed.has(m.id)) this.follow(m);
    }
    if (changed) this.deps.onCount();
  }

  private follow(m: Machine): void {
    const runs = new ActiveRuns();
    const machine: NoticeMachine = { id: m.id, name: m.name, isLocal: false };
    const reloader = new Reloader(async () => {
      const since = runs.mark();
      const list = await this.deps.listRuns(m.id);
      if (this.followed.get(m.id)?.runs !== runs) return;
      const before = runs.count;
      runs.seed(list, since);
      if (runs.count !== before) this.deps.onCount();
    }, this.deps.timers);
    const entry: Followed = {
      machine,
      runs,
      reloader,
      stream: { stop: () => undefined },
    };
    this.followed.set(m.id, entry);
    entry.stream = this.deps.connect(m.id, {
      onEvent: (event) => {
        if (this.followed.get(m.id) !== entry) return;
        if (runs.apply(event)) this.deps.onCount();
        if (event.type === "notification") this.deps.onNotification(entry.machine, event);
      },
      onResync: () => reloader.request(),
    });
    reloader.request();
  }

  private unfollow(id: string): void {
    const f = this.followed.get(id);
    if (!f) return;
    this.followed.delete(id);
    f.stream.stop();
    f.reloader.stop();
  }

  /** Loads the machine list now and every `pollMs`. */
  start(): void {
    if (this.timer !== null) return;
    this.stopped = false;
    void this.refresh();
    const every = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = every(() => void this.refresh(), this.deps.pollMs ?? MACHINE_POLL_MS);
  }

  private stopPolling(): void {
    if (this.timer === null) return;
    const clear =
      this.deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    clear(this.timer);
    this.timer = null;
  }

  /** Stops polling and every other machine's stream. */
  stop(): void {
    this.stopped = true;
    this.polls += 1;
    this.stopPolling();
    for (const id of [...this.followed.keys()]) this.unfollow(id);
  }
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
  if (count === 0) return "AI Orchestrator Review: no active runs";
  return `AI Orchestrator Review: ${count} active ${count === 1 ? "run" : "runs"}`;
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

// ---------------------------------------------------------------------------
// Loading the page and navigating it

/** Chromium's error code for a load that was cancelled, as a blocked navigation is. */
export const ERR_ABORTED = -3;

/** A `did-fail-load` event's details. */
export interface LoadFailure {
  url: string;
  errorCode: number;
  isMainFrame: boolean;
}

/**
 * True when a failed load left the window without the app: the main frame
 * failed to load an app page. A frame inside the page doesn't count, and
 * neither does a cancelled load (a redirect the window blocked) while the
 * window still shows an app page at `currentUrl`.
 */
export function lostAppPage(
  failure: LoadFailure,
  currentUrl: string,
  isAppPage: (url: string) => boolean,
): boolean {
  if (!failure.isMainFrame || !isAppPage(failure.url)) return false;
  return failure.errorCode !== ERR_ABORTED || !isAppPage(currentUrl);
}

/** The page the window shows while the server doesn't answer. */
export function offlinePageUrl(serverUrl: string): string {
  const escaped = serverUrl.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>AI Orchestrator Review</title><style>body{background:#0d0d0d;color:#ddd;font:15px system-ui,sans-serif;margin:3em}</style></head><body><h1>The AI Orchestrator server isn't reachable</h1><p>The app tries ${escaped} again every few seconds and opens the review page once it answers.</p></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/**
 * Holds the route a tray item, a notification, or a deep link asked for
 * until the page can take it: before the app is ready, while the page
 * loads, or while the window shows something other than the app.
 */
export class PendingNavigation {
  private hash: string | null = null;

  /** Returns the hash to send now, or `null` after keeping it for later. */
  request(hash: string, canSend: boolean): string | null {
    if (canSend) {
      this.hash = null;
      return hash;
    }
    this.hash = hash;
    return null;
  }

  /** The kept hash, once, for a page that can take it now. */
  take(): string | null {
    const h = this.hash;
    this.hash = null;
    return h;
  }
}

/** The host operating systems the app runs on, as `process.platform` names them. */
export type HostOs = "linux" | "darwin" | "win32";

/** Narrows `process.platform`, treating any other Unix as Linux. */
export function hostOsOf(platform: string): HostOs {
  return platform === "darwin" || platform === "win32" ? platform : "linux";
}

/**
 * The app's id for Windows, which ties notifications to the Start menu
 * shortcut the installer creates. It must match `appId` in
 * `electron-builder.yml`.
 */
export const APP_USER_MODEL_ID = "dev.aio.review";

/** Whether the app sets the X11 window class and Wayland app_id; only Linux desktops read it. */
export function usesWindowClass(os: HostOs): boolean {
  return os === "linux";
}

/**
 * The arguments for `app.setAsDefaultProtocolClient`. A packaged app
 * registers itself. On Windows, an app run with `electron .` must also
 * name Electron and the app path, or the link starts bare Electron; the
 * other hosts ignore both.
 */
export function protocolClientArgs(
  os: HostOs,
  defaultApp: boolean,
  execPath: string,
  appPath: string | undefined,
): [string] | [string, string, string[]] {
  return os === "win32" && defaultApp && appPath ? [PROTOCOL, execPath, [appPath]] : [PROTOCOL];
}
