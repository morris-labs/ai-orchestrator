// The app's live state: the dashboard model fed by the event stream, the
// usage route's forecasts, and the stream's connection state. The API client
// and the event stream come from `@agentbox/ui`: screens call the server
// with `useApiClient()`, listen to events with `useAnyEvent()`, and read this
// store with `useStore()`.
import type { AgentBoxEvent } from "@agentbox/contracts";
import { ApiClientProvider, EventHubProvider } from "@agentbox/ui/hooks";
import { EventHub, EventsConnection, type ApiClient, type StreamStatus } from "@agentbox/ui/core";
import {
  addUsageSamples,
  applyEvent,
  emptyDashboard,
  OPEN_RUN_STATUSES,
  seedDashboard,
  type DashboardState,
  type VendorUsageInfo,
} from "@agentbox/ui/dashboard";
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
  onEvent(listener: (e: AgentBoxEvent) => void): () => void {
    return this.hub.on("*", listener);
  }

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Applies one event; the stream connection and the tests call it. */
  ingest(event: AgentBoxEvent): void {
    this.set({ dashboard: applyEvent(this.state.dashboard, event) });
    this.hub.emit(event);
    if (event.type === "usage.sample" || event.type === "ceiling.crossed") void this.loadUsage();
  }

  async loadUsage(): Promise<void> {
    try {
      const { vendors } = await this.api.call("usage.get");
      this.set({
        usageInfo: vendors.map((v) => ({
          vendor: v.vendor,
          account: v.account,
          window: v.window,
          forecastAt: v.forecastAt,
          resetAt: v.resetAt,
        })),
      });
    } catch (err) {
      this.set({ error: (err as Error).message });
    }
  }

  async loadUsageHistory(): Promise<void> {
    try {
      const since = new Date(this.now() - USAGE_LOOKBACK_MS).toISOString();
      const { samples } = await this.api.call("usage.samples", { query: { since } });
      this.set({ dashboard: addUsageSamples(this.state.dashboard, samples) });
    } catch (err) {
      this.set({ error: (err as Error).message });
    }
  }

  /**
   * Loads runs, the open runs' rounds and findings, project containers, and
   * box states through REST, and merges them under the events applied
   * meanwhile.
   */
  async loadSnapshot(): Promise<void> {
    const load = ++this.loads;
    try {
      const [{ runs }, { projects }, { boxes }] = await Promise.all([
        this.api.call("runs.list", {}),
        this.api.call("projects.list", {}),
        this.api.call("boxes.list", {}),
      ]);
      const open = runs.filter((r) => OPEN_RUN_STATUSES.includes(r.status));
      const details = await Promise.all(
        open.map(async (r) => {
          const params = { params: { runId: r.id } };
          const [rounds, findings] = await Promise.all([
            this.api.call("runs.rounds", params),
            this.api.call("findings.list", params),
          ]);
          return [r.id, rounds.rounds, findings.findings] as const;
        }),
      );
      if (load !== this.loads) return;
      this.set({
        dashboard: seedDashboard(this.state.dashboard, {
          runs,
          rounds: Object.fromEntries(details.map(([id, rounds]) => [id, rounds])),
          findings: Object.fromEntries(details.map(([id, , findings]) => [id, findings])),
          projects,
          boxes,
          time: new Date(this.now()).toISOString(),
        }),
      });
    } catch (err) {
      if (load === this.loads) this.set({ error: (err as Error).message });
    }
  }

  /**
   * Handles a server hello that couldn't replay, as the contract asks: load
   * state through REST. After the first one, the old state is dropped first.
   */
  private resync(): void {
    if (this.synced) {
      this.set({ dashboard: emptyDashboard(), resets: this.state.resets + 1 });
      this.hub.resync();
      void this.loadUsageHistory();
      void this.loadUsage();
    }
    this.synced = true;
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

  stop(): void {
    this.connection?.stop();
    this.connection = null;
  }
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
