// A fan-out of server events to subscribers, plus the stream status.
import type { AgentBoxEvent, EventOf, EventType } from "@agentbox/contracts";
import type { StreamStatus } from "./connection";

type Handler = (event: AgentBoxEvent) => void;

/** Distributes events by type and tracks the stream status and resyncs. */
export class EventHub {
  private readonly handlers = new Map<EventType | "*", Set<Handler>>();
  private readonly statusListeners = new Set<() => void>();
  private readonly resyncListeners = new Set<() => void>();
  private status: StreamStatus = "closed";
  private resyncCount = 0;

  /** Subscribes to one event type, or `*` for every event. Returns the unsubscribe function. */
  on<T extends EventType>(type: T, handler: (event: EventOf<T>) => void): () => void;
  on(type: "*", handler: Handler): () => void;
  on(type: EventType | "*", handler: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /**
   * Calls every handler for `event`'s type, then every wildcard handler. A
   * handler that throws is reported and skipped, so it can't keep the event
   * from the handlers after it.
   */
  emit(event: AgentBoxEvent): void {
    for (const h of [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get("*") ?? [])]) {
      try {
        h(event);
      } catch (err) {
        console.error(`An event handler for ${event.type} failed:`, err);
      }
    }
  }

  /** Subscribes to resyncs: the moments the state must be reloaded through REST. */
  onResync(listener: () => void): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  resync(): void {
    this.resyncCount += 1;
    for (const l of this.resyncListeners) l();
  }

  get resyncs(): number {
    return this.resyncCount;
  }

  setStatus(status: StreamStatus): void {
    if (status === this.status) return;
    this.status = status;
    for (const l of this.statusListeners) l();
  }

  getStatus = (): StreamStatus => this.status;

  subscribeStatus = (listener: () => void): (() => void) => {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  };
}
