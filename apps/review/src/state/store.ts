// The app's live state: the dashboard model fed by the event stream, the
// usage route's forecasts, and the stream's connection state. Screens read it
// with `useStore()` and listen to raw events with `useEvents()`.
import type { AgentBoxEvent } from "@agentbox/contracts";
import {
  addUsageSamples,
  applyEvent,
  emptyDashboard,
  type DashboardState,
  type VendorUsageInfo,
} from "@agentbox/ui/dashboard";
import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import type { ApiClient } from "../lib/api.js";
import { EventClient, type ConnectionState, type EventClientOptions } from "../lib/events.js";

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
  private state: AppState = {
    dashboard: emptyDashboard(),
    connection: "closed",
    usageInfo: [],
    resets: 0,
    error: null,
  };
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(e: AgentBoxEvent) => void>();
  private client: EventClient | null = null;

  constructor(
    readonly api: ApiClient,
    private readonly socket?: EventClientOptions["socket"],
    private readonly now: () => number = Date.now,
  ) {}

  getState = (): AppState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onEvent(listener: (e: AgentBoxEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Applies one event; the stream client and the tests call it. */
  ingest(event: AgentBoxEvent): void {
    this.set({ dashboard: applyEvent(this.state.dashboard, event) });
    for (const l of this.eventListeners) l(event);
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

  start(): void {
    if (this.client) return;
    void this.loadUsageHistory();
    void this.loadUsage();
    this.client = new EventClient({
      baseUrl: this.api.baseUrl,
      token: this.api.token,
      socket: this.socket,
      onEvent: (e) => this.ingest(e),
      onState: (connection) => {
        this.set({ connection });
        // Ask for a stats sample so the fleet fills without waiting for the timer.
        if (connection === "open") void this.api.call("stats.refresh").catch(() => undefined);
      },
      onReset: () => {
        this.set({ dashboard: emptyDashboard(), resets: this.state.resets + 1 });
        void this.loadUsageHistory();
        void this.loadUsage();
      },
      onInvalid: (_raw, message) => this.set({ error: `Dropped an invalid event: ${message}` }),
    });
    this.client.start();
  }

  stop(): void {
    this.client?.stop();
    this.client = null;
  }
}

export const StoreContext = createContext<AppStore | null>(null);

export function useAppStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useAppStore needs a StoreContext provider.");
  return store;
}

export function useStore<T>(select: (s: AppState) => T): T {
  const store = useAppStore();
  return useSyncExternalStore(store.subscribe, () => select(store.getState()));
}

/** Calls `listener` for every event while the component is mounted. */
export function useEvents(listener: (e: AgentBoxEvent) => void): void {
  const store = useAppStore();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => store.onEvent((e) => ref.current(e)), [store]);
}
