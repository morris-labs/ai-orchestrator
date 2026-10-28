// React bindings for the event hub.
import type { AgentBoxEvent, EventOf, EventType } from "@agentbox/contracts";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { StreamStatus } from "./connection";
import type { EventHub } from "./hub";

const HubContext = createContext<EventHub | null>(null);

export function EventHubProvider({ hub, children }: { hub: EventHub; children: ReactNode }) {
  return <HubContext.Provider value={hub}>{children}</HubContext.Provider>;
}

/** Returns the hub from the nearest `EventHubProvider`. */
export function useEventHub(): EventHub {
  const hub = useContext(HubContext);
  if (!hub) throw new Error("useEventHub needs an EventHubProvider.");
  return hub;
}

/** Calls `handler` for every event of `type`. The handler can change between renders. */
export function useEvent<T extends EventType>(type: T, handler: (event: EventOf<T>) => void): void {
  const hub = useEventHub();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => hub.on(type, (e) => ref.current(e)), [hub, type]);
}

/** Calls `handler` for every event. */
export function useAnyEvent(handler: (event: AgentBoxEvent) => void): void {
  const hub = useEventHub();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => hub.on("*", (e) => ref.current(e)), [hub]);
}

/** Calls `handler` whenever the client must reload its state through REST. */
export function useResync(handler: () => void): void {
  const hub = useEventHub();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => hub.onResync(() => ref.current()), [hub]);
}

/** The event stream's connection status. */
export function useStreamStatus(): StreamStatus {
  const hub = useEventHub();
  return useSyncExternalStore(hub.subscribeStatus, hub.getStatus, hub.getStatus);
}
