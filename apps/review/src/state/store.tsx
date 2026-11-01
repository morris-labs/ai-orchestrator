// The app's live state: the dashboard model fed by the event stream, the
// usage route's forecasts, and the stream's connection state. The API client
// and the event stream come from `@aio/ui`: screens call the server
// with `useApiClient()`, listen to events with `useAnyEvent()`, and read this
// store with `useStore()`.
import type { AioEvent } from "@aio/contracts";
import { ApiClientProvider, EventHubProvider } from "@aio/ui/hooks";
import { EventHub, EventsConnection, type ApiClient, type StreamStatus } from "@aio/ui/core";
import {
  addUsageSamples,
  applyEvent,
  emptyDashboard,
  OPEN_RUN_STATUSES,
  seedDashboard,
  type DashboardState,
  type VendorUsageInfo,
} from "@aio/ui/dashboard";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

export type ConnectionState = StreamStatus;

export interface AppState {
  dashboard: DashboardState;
  connection: ConnectionState;
  usageInfo: VendorUsageInfo[];
  /** Increases when the stream couldn't resume; screens reload through REST. */
  resets: number;
  /** The last error the store hit while loading, for the status bar. */
  error: string | null;
}

/** How far back the usage chart starts. */
export const USAGE_LOOKBACK_MS = 6 * 60 * 60 * 1000;

/** How many open runs the snapshot loads the rounds and findings of at once. */
export const SNAPSHOT_RUN_CONCURRENCY = 4;

/** The first delay before a failed snapshot load runs again; it doubles up to the maximum. */
export const SNAPSHOT_RETRY_MS = 1000;
export const SNAPSHOT_RETRY_MAX_MS = 30_000;

export class AppStore {
  /** Fans the stream's events out to screens; `EventHubProvider` shares it. */
  readonly hub = new EventHub();
  private state: AppState = {
    dashboard: emptyDashboard(),
    connection: "closed",
    usageInfo: [],
    resets: 0,
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private connection: EventsConnection | null = null;
  /** False until the first server hello: the first resync loads without a reset. */
  private synced = false;
  /** Counts snapshot loads, so that only the latest one applies. */
  private loads = 0;
  /**
   * Boxes and containers that events removed since the latest snapshot load
   * started, or `null` when no load runs. The snapshot may predate those
   * events, so it must not bring them back.
   */
  private removedDuringLoad: { boxes: Set<string>; containers: Set<string> } | null = null;
  /**
   * After a stream reset, the dashboard the next snapshot seeds: the events
   * since the reset applied to an empty dashboard. Screens keep the old
   * dashboard until that snapshot applies. `null` when no reset waits.
   */
  private rebuilding: DashboardState | null = null;
  /** The error the last snapshot load reported, so that a later success clears only that. */
  private snapshotError: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  /** The errors the last usage and usage history loads reported, so a success clears only those. */
  private usageError: string | null = null;
  private usageHistoryError: string | null = null;
  /** The usage load in flight, and whether another must follow it. */
  private usageLoad: Promise<void> | null = null;
  private usageAgain = false;

  constructor(
    readonly api: ApiClient,
    private readonly now: () => number = Date.now,
  ) {}

  getState = (): AppState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Calls `listener` for every event the store applies. */
  onEvent(listener: (e: AioEvent) => void): () => void {
    return this.hub.on("*", listener);
  }

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Applies one event; the stream connection and the tests call it. */
  ingest(event: AioEvent): void {
    this.trackRemoval(event);
    if (this.rebuilding) this.rebuilding = applyEvent(this.rebuilding, event);
    this.set({ dashboard: applyEvent(this.state.dashboard, event) });
    this.hub.emit(event);
    if (event.type === "usage.sample" || event.type === "ceiling.crossed") void this.loadUsage();
  }

  private trackRemoval(event: AioEvent): void {
    const removed = this.removedDuringLoad;
    if (!removed) return;
    if (event.type === "box.changed") {
      if (event.box === null) removed.boxes.add(event.boxId);
      else removed.boxes.delete(event.boxId);
    } else if (event.type === "container.changed") {
      if (event.state === "removed") removed.containers.add(event.container);
      else removed.containers.delete(event.container);
    }
  }

  /**
   * Replaces an error this store reported (`previous`) with `next`: a new
   * error shows, and `null` clears `previous` only when it still shows.
   */
  private replaceError(previous: string | null, next: string | null): void {
    if (next !== null) this.set({ error: next });
    else if (previous !== null && this.state.error === previous) this.set({ error: null });
  }

  /**
   * Loads the usage. A call while a load runs doesn't start another one at
   * once: one more load follows the running one, so a burst of samples
   * makes at most two calls and the newest answer wins.
   */
  loadUsage(): Promise<void> {
    if (this.usageLoad) {
      this.usageAgain = true;
      return this.usageLoad;
    }
    this.usageLoad = (async () => {
      try {
        do {
          this.usageAgain = false;
          await this.fetchUsage();
        } while (this.usageAgain);
      } finally {
        this.usageLoad = null;
      }
    })();
    return this.usageLoad;
  }

  private async fetchUsage(): Promise<void> {
    const previous = this.usageError;
    try {
      const { vendors } = await this.api.call("usage.get");
      this.usageError = null;
      this.set({
        usageInfo: vendors.map((v) => ({
          vendor: v.vendor,
          account: v.account,
          window: v.window,
          forecastAt: v.forecastAt,
          resetAt: v.resetAt,
        })),
      });
      this.replaceError(previous, null);
    } catch (err) {
      this.usageError = (err as Error).message;
      this.replaceError(previous, this.usageError);
    }
  }

  async loadUsageHistory(): Promise<void> {
    const previous = this.usageHistoryError;
    try {
      const since = new Date(this.now() - USAGE_LOOKBACK_MS).toISOString();
      const { samples } = await this.api.call("usage.samples", { query: { since } });
      this.usageHistoryError = null;
      this.set({ dashboard: addUsageSamples(this.state.dashboard, samples) });
      this.replaceError(previous, null);
    } catch (err) {
      this.usageHistoryError = (err as Error).message;
      this.replaceError(previous, this.usageHistoryError);
    }
  }

  /**
   * Loads runs, the open runs' rounds and findings, project containers, and
   * box states through REST, and merges them under the events applied
   * meanwhile. After a stream reset, the snapshot replaces the old
   * dashboard, and only then do screens hear about the reset. A load that
   * fails while the stream runs is tried again with backoff.
   */
  async loadSnapshot(): Promise<void> {
    this.clearRetry();
    const load = ++this.loads;
    const current = () => load === this.loads;
    // The snapshot shows the server as it was at this time or later.
    const time = new Date(this.now()).toISOString();
    const removed = { boxes: new Set<string>(), containers: new Set<string>() };
    this.removedDuringLoad = removed;
    try {
      const [{ runs }, { projects }, { boxes }] = await Promise.all([
        this.api.call("runs.list", {}),
        this.api.call("projects.list", {}),
        this.api.call("boxes.list", {}),
      ]);
      const open = runs.filter((r) => OPEN_RUN_STATUSES.includes(r.status));
      // One run's failure, such as a run deleted meanwhile, keeps the rest.
      const settled = await settleLimited(
        open,
        SNAPSHOT_RUN_CONCURRENCY,
        async (r) => {
          const params = { params: { runId: r.id } };
          const [rounds, findings] = await Promise.all([
            this.api.call("runs.rounds", params),
            this.api.call("findings.list", params),
          ]);
          return [r.id, rounds.rounds, findings.findings] as const;
        },
        () => !current(),
      );
      if (!current()) return;
      const details = settled.flatMap((x) => (x.status === "fulfilled" ? [x.value] : []));
      const failed = settled.flatMap((x, i) =>
        x.status === "rejected" ? [`${open[i]!.id}: ${errorText(x.reason)}`] : [],
      );
      const reset = this.rebuilding !== null;
      const base = this.rebuilding ?? this.state.dashboard;
      this.rebuilding = null;
      this.retryAttempt = 0;
      const error =
        failed.length > 0
          ? `Couldn't load the rounds and findings of ${failed.length} run(s): ${failed.join("; ")}`
          : null;
      // A success clears the error an earlier snapshot load left, and no other.
      const otherError = this.state.error !== null && this.state.error !== this.snapshotError;
      this.snapshotError = error;
      this.set({
        dashboard: seedDashboard(base, {
          runs,
          rounds: Object.fromEntries(details.map(([id, rounds]) => [id, rounds])),
          findings: Object.fromEntries(details.map(([id, , findings]) => [id, findings])),
          projects,
          boxes,
          time,
          removed,
        }),
        ...(reset ? { resets: this.state.resets + 1 } : {}),
        ...(error !== null || !otherError ? { error } : {}),
      });
      if (failed.length > 0) console.warn("Snapshot load skipped runs:", failed);
      if (reset) {
        this.hub.resync();
        void this.loadUsageHistory();
        void this.loadUsage();
      }
    } catch (err) {
      if (!current()) return;
      this.snapshotError = errorText(err);
      this.set({ error: this.snapshotError });
      this.scheduleRetry();
    } finally {
      if (current()) this.removedDuringLoad = null;
    }
  }

  /** Runs the snapshot load again later, while the stream runs. */
  private scheduleRetry(): void {
    if (!this.connection) return;
    const delay = Math.min(SNAPSHOT_RETRY_MAX_MS, SNAPSHOT_RETRY_MS * 2 ** this.retryAttempt);
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.loadSnapshot();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /**
   * Handles a server hello that couldn't replay, as the contract asks: load
   * state through REST. After the first one, the snapshot replaces the old
   * state instead of merging into it.
   */
  private resync(): void {
    if (this.synced) this.rebuilding = emptyDashboard();
    this.synced = true;
    this.retryAttempt = 0;
    void this.loadSnapshot();
  }

  start(): void {
    if (this.connection) return;
    void this.loadUsageHistory();
    void this.loadUsage();
    this.connection = new EventsConnection({
      client: this.api,
      onEvent: (e) => this.ingest(e),
      onStatus: (connection) => {
        this.hub.setStatus(connection);
        this.set({ connection });
        // Ask for a stats sample so the fleet fills without waiting for the timer.
        if (connection === "open") void this.api.call("stats.refresh").catch(() => undefined);
      },
      onResync: () => this.resync(),
      onInvalidFrame: (_raw, message) =>
        this.set({ error: `Dropped an invalid event: ${message}` }),
    });
    this.connection.start();
  }

  /**
   * Stops the stream and drops a snapshot still loading. The store stays
   * synced, so the first hello after `start()` replaces the dashboard, which
   * missed the events while the stream was stopped.
   */
  stop(): void {
    this.connection?.stop();
    this.connection = null;
    this.clearRetry();
    this.loads += 1;
    this.removedDuringLoad = null;
    this.rebuilding = null;
  }
}

/**
 * Calls `fn` on each item, at most `limit` at a time, and settles each call
 * like `Promise.allSettled`. Once `cancelled()` returns true, no new call
 * starts and each remaining item settles as rejected.
 */
async function settleLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  cancelled: () => boolean,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      if (cancelled()) {
        results[i] = { status: "rejected", reason: new Error("A newer load replaced this one.") };
        continue;
      }
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const StoreContext = createContext<AppStore | null>(null);

/** Provides the store, its API client, and its event hub to the tree. */
export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return (
    <StoreContext.Provider value={store}>
      <ApiClientProvider client={store.api}>
        <EventHubProvider hub={store.hub}>{children}</EventHubProvider>
      </ApiClientProvider>
    </StoreContext.Provider>
  );
}

export function useAppStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useAppStore needs a StoreProvider.");
  return store;
}

export function useStore<T>(select: (s: AppState) => T): T {
  const store = useAppStore();
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}
