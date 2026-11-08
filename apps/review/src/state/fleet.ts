// The machines of a multi-host setup, for the Review app. The fleet keeps
// one `AppStore` per machine that the user opens, so the screens show that
// machine's runs live, and a run list from every machine for the
// dashboard. A machine that can't answer shows as offline; it never fails
// the whole view. Its last runs show only when the viewer turns on
// `showOfflineRuns`, with the time they were listed.
import { LOCAL_MACHINE_ID, type Machine, type RunState } from "@aio/contracts";
import { isApiError, type ApiClient, type ClientErrorCode } from "@aio/ui/core";
import { AppStore } from "./store.js";

/** The `localStorage` key of the viewer's `showOfflineRuns` choice. */
export const SHOW_OFFLINE_RUNS_KEY = "aio.review.showOfflineRuns";

/** The part of `Storage` the fleet uses to keep the viewer's choices. */
export type PrefStorage = Pick<Storage, "getItem" | "setItem">;

/** The browser's `localStorage`, or `null` where it can't be used. */
function defaultStorage(): PrefStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** How often the fleet reloads the machine list and each machine's runs. */
export const FLEET_POLL_MS = 10_000;

/** The error codes that mean a machine can't be reached through the hub. */
const UNREACHABLE_CODES: ClientErrorCode[] = [
  "machine_offline",
  "machine_timeout",
  "hub_unreachable",
  "unreachable",
];

/** Why a machine has no current list when the machine list itself failed. */
const LIST_FAILED = "The machine list didn't load, so this machine's state is unknown.";

/** How one machine answered the last run list. */
export type MachineReach = "loading" | "online" | "offline" | "error";

export interface FleetMachine {
  machine: Machine;
  reach: MachineReach;
  /** Why the last run list failed, or `null`. */
  error: string | null;
  /**
   * The runs the machine last listed; kept while it's offline, though
   * `fleetRuns()` shows them then only with `showOfflineRuns`.
   */
  runs: RunState[];
  /** When `runs` last loaded, or `null` before the first list. */
  loadedAt: string | null;
}

export interface FleetState {
  /** `null` until the first answer; false when the server has no machine routes. */
  supported: boolean | null;
  /** This machine first, then the others by name; revoked and enrolling machines left out. */
  machines: FleetMachine[];
  /** The machine the screens show. */
  selected: string;
  /**
   * Why the last machine list failed, or `null`. The last good list stays in
   * place, with each machine marked as having no current list.
   */
  error: string | null;
  /**
   * The viewer's choice to show the last runs of a machine without a
   * current list. Off by default: such a machine shows as offline with no
   * runs.
   */
  showOfflineRuns: boolean;
}

/** One run with the machine it runs on, for the all-machines view. */
export interface FleetRun {
  machineId: string;
  machineName: string;
  reach: MachineReach;
  run: RunState;
}

/** True when the fleet has more than one machine, so the app names the machine. */
export function isMulti(state: FleetState): boolean {
  return state.supported === true && state.machines.length > 1;
}

/** Whether a machine's server is known to have a capability. */
export type CapabilitySupport = "yes" | "no" | "unknown";

/**
 * Whether `machineId`'s server has `capability`. "yes" when the machine list
 * shows it with one. "no" when the server has no machine routes at all,
 * which only an older server lacks, or when the list shows a reachable
 * machine without one. "unknown" when the fleet can't tell: before the first
 * list answer, after a failed one, while the list doesn't name the machine,
 * or while the machine is unreachable, since an offline entry can be a
 * placeholder with no capabilities.
 */
export function machineSupports(
  state: FleetState,
  machineId: string,
  capability: string,
): CapabilitySupport {
  if (state.supported === false) return "no";
  if (state.supported === null) return "unknown";
  const m = state.machines.find((e) => e.machine.id === machineId);
  if (m === undefined) return "unknown";
  if (m.machine.capabilities.includes(capability)) return "yes";
  const offline = !m.machine.isLocal && m.machine.status === "offline";
  return offline || !isCurrent(m) ? "unknown" : "no";
}

/** True unless the last run list or machine list failed, so the machine's runs are current. */
export function isCurrent(m: FleetMachine): boolean {
  return m.reach === "online" || m.reach === "loading";
}

/**
 * The runs a machine shows: all of them while it's current, and its last
 * runs otherwise only with `showOfflineRuns`.
 */
export function shownRuns(state: FleetState, m: FleetMachine): RunState[] {
  return isCurrent(m) || state.showOfflineRuns ? m.runs : [];
}

/** Every shown machine's runs, most recently updated first. */
export function fleetRuns(state: FleetState): FleetRun[] {
  return state.machines
    .flatMap((m) =>
      shownRuns(state, m).map((run) => ({
        machineId: m.machine.id,
        machineName: m.machine.name,
        reach: m.reach,
        run,
      })),
    )
    .sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
}

/** True for a machine the fleet shows: this one, or an enrolled one that isn't revoked. */
function shown(m: Machine): boolean {
  return m.isLocal || m.status === "online" || m.status === "offline";
}

/** This machine first, then the others by name. */
function sortMachines(machines: readonly Machine[]): Machine[] {
  return [...machines].sort(
    (a, b) => Number(b.isLocal) - Number(a.isLocal) || a.name.localeCompare(b.name),
  );
}

/** True when an error means the server has no machine routes, as an older server. */
function unsupported(err: unknown): boolean {
  return isApiError(err) && [404, 405, 501].includes(err.status);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A machine's REST run list (`listed`) merged with the runs its events
 * changed meanwhile (`live`): a newer live run wins, and a live run the list
 * lacks stays when an event touched it after the load started (`since`).
 */
export function mergeRuns(listed: readonly RunState[], live: readonly RunState[], since: string) {
  const byId = new Map(live.map((x) => [x.id, x]));
  const merged = listed.map((y) => {
    const x = byId.get(y.id);
    return x && x.updatedAt > y.updatedAt ? x : y;
  });
  const ids = new Set(listed.map((y) => y.id));
  const added = live.filter((x) => !ids.has(x.id) && x.updatedAt >= since);
  return [...added, ...merged];
}

/** `runs` with `run` in place of the run with its ID, newest first. */
function upsertRun(runs: readonly RunState[], run: RunState): RunState[] {
  return [run, ...runs.filter((r) => r.id !== run.id)];
}

export class MachineFleet {
  private state: FleetState = {
    supported: null,
    machines: [],
    selected: LOCAL_MACHINE_ID,
    error: null,
    showOfflineRuns: false,
  };
  private readonly listeners = new Set<() => void>();
  /** The store of each machine the user opened; `local` is the root store. */
  private readonly stores = new Map<string, AppStore>();
  /** A lightweight client per machine, for the run lists. */
  private readonly clients = new Map<string, ApiClient>();
  /** Stops following each store's run changes, by machine. */
  private readonly follows = new Map<string, () => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private loads = 0;
  /** The newest load whose machine list failed. */
  private listFailedLoad = 0;
  /** The newest load that each kind of answer has applied, by `answer()` key. */
  private readonly answered = new Map<string, number>();
  /** The fleet ignores answers from this load and earlier ones. */
  private cutoff = 0;

  /**
   * `root` is this server's store. `makeClient` makes the API client of a
   * machine, such as with `createMachineClient()`. `storage` keeps the
   * viewer's choices, such as `showOfflineRuns`; `null` keeps them in memory.
   */
  constructor(
    readonly root: AppStore,
    private readonly makeClient: (machineId: string) => ApiClient,
    private readonly pollMs = FLEET_POLL_MS,
    private readonly now: () => number = Date.now,
    private readonly storage: PrefStorage | null = defaultStorage(),
  ) {
    this.stores.set(LOCAL_MACHINE_ID, root);
    this.state.showOfflineRuns = this.readPref(SHOW_OFFLINE_RUNS_KEY);
  }

  private readPref(key: string): boolean {
    try {
      return this.storage?.getItem(key) === "true";
    } catch {
      return false;
    }
  }

  /** Shows or hides the last runs of machines without a current list, and keeps the choice. */
  setShowOfflineRuns(show: boolean): void {
    try {
      this.storage?.setItem(SHOW_OFFLINE_RUNS_KEY, String(show));
    } catch {
      // A storage that refuses the write keeps the choice for this session.
    }
    if (this.state.showOfflineRuns !== show) this.set({ showOfflineRuns: show });
  }

  getState = (): FleetState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<FleetState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private client(machineId: string): ApiClient {
    if (machineId === LOCAL_MACHINE_ID) return this.root.api;
    let c = this.clients.get(machineId);
    if (!c) {
      c = this.makeClient(machineId);
      this.clients.set(machineId, c);
    }
    return c;
  }

  /**
   * The store of `machineId`. The first call for another machine makes the
   * store and starts its event stream through the hub.
   */
  storeFor(machineId: string): AppStore {
    let store = this.stores.get(machineId);
    if (!store) {
      store = new AppStore(this.makeClient(machineId), this.now);
      this.stores.set(machineId, store);
      this.follow(machineId, store);
      store.start();
    }
    return store;
  }

  /** Keeps `machineId`'s run list current with the run changes its store hears. */
  private follow(machineId: string, store: AppStore): void {
    this.follows.get(machineId)?.();
    this.follows.set(
      machineId,
      store.onEvent((e) => {
        if (e.type !== "run.changed") return;
        this.set({
          machines: this.state.machines.map((m) =>
            m.machine.id === machineId ? { ...m, runs: upsertRun(m.runs, e.run) } : m,
          ),
        });
      }),
    );
  }

  /**
   * True when the screens can show `machineId`: this machine, a machine in
   * the last list, or any machine before the first answer, which then
   * corrects a wrong choice.
   */
  canSelect(machineId: string): boolean {
    const { supported, machines } = this.state;
    return (
      machineId === LOCAL_MACHINE_ID ||
      supported === null ||
      machines.some((m) => m.machine.id === machineId)
    );
  }

  /**
   * Shows `machineId` in the screens. Ignores a machine that `canSelect()`
   * refuses, such as a revoked one that a link still names.
   */
  select(machineId: string): void {
    if (!this.canSelect(machineId)) return;
    this.storeFor(machineId);
    if (this.state.selected !== machineId) this.set({ selected: machineId });
  }

  /**
   * True when an answer from `load` is newer than the last one applied for
   * `key`, and records it. Loads overlap when an answer takes longer than a
   * poll, so a slow answer still applies unless a newer one came first.
   */
  private answer(key: string, load: number): boolean {
    if (load <= this.cutoff || load <= (this.answered.get(key) ?? 0)) return false;
    this.answered.set(key, load);
    return true;
  }

  /**
   * Reloads the machine list, then every shown machine's runs in parallel.
   * Each machine's answer applies when it arrives, so a slow machine holds up
   * only itself.
   */
  async refresh(): Promise<void> {
    const load = ++this.loads;
    let machines: Machine[];
    try {
      ({ machines } = await this.root.api.call("machines.list"));
    } catch (err) {
      if (!this.answer("machines", load)) return;
      if (unsupported(err)) {
        // An older server: one machine, as before, and no more polling.
        this.stopPolling();
        this.cutoff = this.loads;
        this.set({ supported: false, machines: [], selected: LOCAL_MACHINE_ID, error: null });
        this.dropStores(new Set());
      } else {
        // Without a list, no machine's runs are known to be current, and a run
        // list that an earlier load started mustn't say otherwise.
        this.listFailedLoad = load;
        const reach = isApiError(err, ...UNREACHABLE_CODES) ? "offline" : "error";
        this.set({
          error: errorText(err),
          machines: this.state.machines.map((m) => ({ ...m, reach, error: LIST_FAILED })),
        });
      }
      return;
    }
    if (!this.answer("machines", load)) return;
    const list = sortMachines(machines.filter(shown));
    const previous = new Map(this.state.machines.map((m) => [m.machine.id, m]));
    const entries = list.map((machine): FleetMachine => ({
      machine,
      reach: previous.get(machine.id)?.reach ?? "loading",
      error: previous.get(machine.id)?.error ?? null,
      runs: previous.get(machine.id)?.runs ?? [],
      loadedAt: previous.get(machine.id)?.loadedAt ?? null,
    }));
    const selected = list.some((m) => m.id === this.state.selected)
      ? this.state.selected
      : LOCAL_MACHINE_ID;
    this.set({ supported: true, machines: entries, selected, error: null });
    this.dropStores(new Set(list.map((m) => m.id)));
    const startedAt = new Date(this.now()).toISOString();
    await Promise.all(
      list.map(async (m) => this.applyRuns(load, startedAt, await this.loadRuns(m))),
    );
  }

  /** Applies one machine's answer from `load`, unless a newer answer came first. */
  private applyRuns(load: number, startedAt: string, r: FleetMachine): void {
    if (load < this.listFailedLoad) return;
    if (!this.answer(`runs:${r.machine.id}`, load)) return;
    this.set({
      machines: this.state.machines.map((m) => {
        if (m.machine.id !== r.machine.id) return m;
        if (r.reach !== "online") {
          return { ...r, machine: m.machine, runs: m.runs, loadedAt: m.loadedAt };
        }
        return { ...r, machine: m.machine, runs: mergeRuns(r.runs, m.runs, startedAt) };
      }),
    });
  }

  /** One machine's run list, or why it can't give one, with its last runs kept. */
  private async loadRuns(machine: Machine): Promise<FleetMachine> {
    const old = this.state.machines.find((m) => m.machine.id === machine.id);
    const stale = { machine, runs: old?.runs ?? [], loadedAt: old?.loadedAt ?? null };
    if (!machine.isLocal && machine.status === "offline") {
      return { ...stale, reach: "offline", error: "The hub reports this machine offline." };
    }
    try {
      const { runs } = await this.client(machine.isLocal ? LOCAL_MACHINE_ID : machine.id).call(
        "runs.list",
        {},
      );
      return {
        machine,
        reach: "online",
        error: null,
        runs,
        loadedAt: new Date(this.now()).toISOString(),
      };
    } catch (err) {
      const reach = isApiError(err, ...UNREACHABLE_CODES) ? "offline" : "error";
      return { ...stale, reach, error: errorText(err) };
    }
  }

  /**
   * Stops and forgets the store of every other machine outside `keep`, such
   * as a revoked machine or an unknown one that a deep link named.
   */
  private dropStores(keep: ReadonlySet<string>): void {
    for (const [id, store] of this.stores) {
      if (id === LOCAL_MACHINE_ID || keep.has(id)) continue;
      this.follows.get(id)?.();
      this.follows.delete(id);
      store.stop();
      this.stores.delete(id);
      this.clients.delete(id);
    }
  }

  /** Loads the fleet now and every `pollMs`, and follows this machine's run changes. */
  start(): void {
    if (this.timer !== null) return;
    if (!this.follows.has(LOCAL_MACHINE_ID)) this.follow(LOCAL_MACHINE_ID, this.root);
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.pollMs);
  }

  private stopPolling(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stops polling and every other machine's store; the root store keeps running. */
  stop(): void {
    this.stopPolling();
    this.cutoff = this.loads;
    this.dropStores(new Set());
    this.follows.get(LOCAL_MACHINE_ID)?.();
    this.follows.delete(LOCAL_MACHINE_ID);
  }
}
