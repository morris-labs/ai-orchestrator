// The machine a boxes view belongs to. A multi-machine window renders one
// `App` per machine, each inside a `MachineScope` whose API client and
// event stream go to that machine through the hub. `useMachine()` tells
// the view which machine it shows and whether it is in front.
import {
  ApiClientProvider,
  EventHub,
  EventHubProvider,
  EventsConnection,
  MessageBoxLabel,
  ToastLabel,
  type ApiClient,
} from "@aio/ui";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { LOCAL_MACHINE_ID } from "../logic/machines";

/** Event types the boxes app uses. */
export const BOX_EVENT_TYPES = [
  "box.changed",
  "container.changed",
  "container.stats",
  "ports.changed",
  "terminal.ended",
  "settings.changed",
  "notification",
  // The Builds page and the build view. The server sends a type only to a
  // client that asks for it.
  "build.changed",
  "build.task.changed",
  "build.inbox",
  "message.sent",
  "lease.settled",
  "build.seat.usage",
] as const;

export interface MachineInfo {
  /** The machine id; `local` for this server. */
  id: string;
  /** The machine's enrolled name; empty for a single-machine window. */
  name: string;
  /** True for this server's own machine. */
  isLocal: boolean;
  /** True when the window shows more than one machine, so labels name the machine. */
  multi: boolean;
  /** True while this machine's view is in front. */
  active: boolean;
  /** Brings this machine's view to the front. */
  activate: () => void;
  /** Opens the Machines page, or `null` when the server has no machine routes. */
  openMachines: (() => void) | null;
}

export const SINGLE_MACHINE: MachineInfo = {
  id: LOCAL_MACHINE_ID,
  name: "",
  isLocal: true,
  multi: false,
  active: true,
  activate: () => undefined,
  openMachines: null,
};

const MachineContext = createContext<MachineInfo>(SINGLE_MACHINE);

export function MachineProvider({ value, children }: { value: MachineInfo; children: ReactNode }) {
  // Message boxes and toasts show over every view, so in a multi-machine
  // window they name the machine they came from.
  const label = value.multi ? value.name : undefined;
  return (
    <MachineContext.Provider value={value}>
      <MessageBoxLabel label={label}>
        <ToastLabel label={label}>{children}</ToastLabel>
      </MessageBoxLabel>
    </MachineContext.Provider>
  );
}

/** The machine of the nearest `MachineProvider`; this server alone without one. */
export function useMachine(): MachineInfo {
  return useContext(MachineContext);
}

/**
 * Provides an API client and that client's event stream to `children`.
 * Each machine gets its own scope, so its events, resyncs, and stream
 * status never mix with another machine's.
 */
export function MachineScope({ client, children }: { client: ApiClient; children: ReactNode }) {
  const hub = useMemo(() => new EventHub(), []);
  useEffect(() => {
    const conn = new EventsConnection({
      client,
      types: BOX_EVENT_TYPES,
      onEvent: (e) => hub.emit(e),
      onResync: () => hub.resync(),
      onStatus: (s) => hub.setStatus(s),
      onInvalidFrame: (_raw, error) =>
        console.warn(`Dropped an event frame that breaks the contract: ${error}`),
    });
    conn.start();
    return () => conn.stop();
  }, [client, hub]);
  return (
    <ApiClientProvider client={client}>
      <EventHubProvider hub={hub}>{children}</EventHubProvider>
    </ApiClientProvider>
  );
}
