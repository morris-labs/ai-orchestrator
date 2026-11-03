// The machine tabs. With more than one machine, a tab strip above the
// window holds one tab per machine, this PC first, and a Machines tab;
// each machine tab shows that machine's full boxes view, with its own API
// client, event stream, selection, filter, and terminals. Every view stays
// mounted while another is in front, so its terminals stay attached. With
// one machine, or a server without machine routes, the window is the
// boxes view alone, as before.
import type { Machine } from "@aio/contracts";
import {
  StatusDot,
  focusOpenDialog,
  hasOpenDialog,
  useApiClient,
  useChords,
  useMessageBoxOpen,
  type ApiClient,
} from "@aio/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MachinesPage } from "../components/MachinesPage";
import {
  LOCAL_MACHINE_ID,
  hasTab,
  lastSeenText,
  machineDot,
  machineStatusLabel,
  skewNotes,
} from "../logic/machines";
import { App } from "./App";
import { bridge } from "../bridge";
import { CHORDS } from "./chords";
import { MachineProvider, MachineScope, type MachineInfo } from "./machine";
import { useMachines } from "./useMachines";

/** The view key of the Machines page; machine views use the machine id. */
export const MACHINES_VIEW = "@machines";

export interface ShellProps {
  /**
   * Makes the API client of a machine, with `createMachineClient()` and the
   * options of this server's client. Without it, the window shows this PC
   * alone.
   */
  machineClient?: (machineId: string) => ApiClient;
  /** How often the machine list reloads, in milliseconds. */
  pollMs?: number;
}

export function Shell({ machineClient, pollMs }: ShellProps) {
  const root = useApiClient();
  const { supported, machines, error, reload } = useMachines(root, pollMs);
  const [view, setView] = useState<string>(LOCAL_MACHINE_ID);
  const messageOpen = useMessageBoxOpen();

  const local = machines.find((m) => m.isLocal);
  const remotes = machineClient ? machines.filter(hasTab) : [];
  const multi = remotes.length > 0;
  const showStrip = supported === true && (multi || view === MACHINES_VIEW);
  const views = [LOCAL_MACHINE_ID, ...remotes.map((m) => m.id), MACHINES_VIEW];

  // A machine that loses its tab, such as a revoked one, falls back to this PC.
  useEffect(() => {
    if (view !== LOCAL_MACHINE_ID && view !== MACHINES_VIEW && !remotes.some((m) => m.id === view))
      setView(LOCAL_MACHINE_ID);
    // Without machine routes the strip is gone, so the Machines page has no way out.
    if (view === MACHINES_VIEW && supported === false) setView(LOCAL_MACHINE_ID);
  }, [view, remotes, supported]);

  // A dialog can't keep focus while its view is hidden, so it takes focus back
  // when the view returns. This effect runs after the effects of the views.
  useEffect(() => focusOpenDialog(), [view]);

  // One client per machine, kept across reloads so a view never reconnects
  // just because the list was polled.
  const clients = useRef(new Map<string, ApiClient>());
  const factory = useRef(machineClient);
  if (factory.current !== machineClient) {
    factory.current = machineClient;
    clients.current.clear();
  }
  const clientFor = (id: string): ApiClient => {
    let c = clients.current.get(id);
    if (!c) {
      c = machineClient ? machineClient(id) : root;
      clients.current.set(id, c);
    }
    return c;
  };

  const openMachines = supported === true ? () => setView(MACHINES_VIEW) : null;
  const step = (delta: number) => {
    // A dialog is modal: the user answers it before leaving its view.
    if (hasOpenDialog()) return;
    const i = Math.max(0, views.indexOf(view));
    setView(views[(i + delta + views.length) % views.length] ?? LOCAL_MACHINE_ID);
  };
  useChords(
    showStrip && !messageOpen
      ? [
          { chord: CHORDS.nextMachine, run: () => step(1) },
          { chord: CHORDS.prevMachine, run: () => step(-1) },
          // No App is active on the Machines page, so the application chords
          // that still make sense there are bound here.
          ...(view === MACHINES_VIEW
            ? [
                {
                  chord: CHORDS.quit,
                  run: () => {
                    if (hasOpenDialog()) return;
                    const b = bridge();
                    if (b) b.quit();
                    else window.close();
                  },
                },
                {
                  chord: CHORDS.refresh,
                  run: () => {
                    if (!hasOpenDialog()) void reload();
                  },
                },
              ]
            : []),
        ]
      : [],
  );

  const infoFor = (id: string, name: string, isLocal: boolean): MachineInfo => ({
    id,
    name,
    isLocal,
    multi,
    active: view === id,
    activate: () => setView(id),
    openMachines,
  });
  // With an enrolled hub, the server's machine isn't this PC, so its terminals
  // and directories go through the server, as another machine's do.
  const localInfo = infoFor(LOCAL_MACHINE_ID, local?.name ?? "This PC", !bridge()?.remoteHub);

  return (
    <div className="bx-shell">
      {showStrip ? (
        <MachineStrip local={local} remotes={remotes} view={view} onSelect={setView} />
      ) : null}
      <div className="bx-machine-pane" hidden={view !== LOCAL_MACHINE_ID}>
        <MachineProvider value={localInfo}>
          <App />
        </MachineProvider>
      </div>
      {remotes.map((m) => (
        <div key={m.id} className="bx-machine-pane" hidden={view !== m.id}>
          <RemoteMachine machine={m} client={clientFor(m.id)} info={infoFor(m.id, m.name, false)} />
        </div>
      ))}
      {view === MACHINES_VIEW ? (
        <div className="bx-machine-pane">
          <MachinesPage
            client={root}
            machines={machines}
            error={error}
            reload={reload}
            onOpen={(id) => setView(id === local?.id ? LOCAL_MACHINE_ID : id)}
          />
        </div>
      ) : null}
    </div>
  );
}

function MachineStrip({
  local,
  remotes,
  view,
  onSelect,
}: {
  local: Machine | undefined;
  remotes: Machine[];
  view: string;
  onSelect: (view: string) => void;
}) {
  const tab = (key: string, label: ReactNode, title: string, dot?: Machine) => (
    <button
      key={key}
      type="button"
      role="tab"
      aria-selected={view === key}
      className={`ab-tab${view === key ? " ab-active" : ""}`}
      title={`${title}\n${CHORDS.prevMachine} and ${CHORDS.nextMachine} switch tabs.`}
      onClick={() => onSelect(key)}
    >
      {dot ? <StatusDot decorative state={machineDot(dot)} /> : null}
      {label}
    </button>
  );
  return (
    <div className="ab-tabbar bx-machine-strip" role="tablist" aria-label="Machines">
      {tab(
        LOCAL_MACHINE_ID,
        `${local?.name ?? "This PC"} (this PC)`,
        "The boxes on this PC.",
        local,
      )}
      {remotes.map((m) => {
        const notes = skewNotes(m, local);
        return tab(
          m.id,
          <>
            {m.name}
            {notes.length > 0 ? (
              <span className="bx-machine-skew" aria-label="version differs">
                {" "}
                !
              </span>
            ) : null}
          </>,
          [
            `${m.name}: ${machineStatusLabel[m.status]}`,
            ...(m.status === "online" ? [] : [`Last seen ${lastSeenText(m)}`]),
            ...notes,
          ].join("\n"),
          m,
        );
      })}
      <span className="ab-spacer" />
      {tab(MACHINES_VIEW, "Machines", "Enroll, check, and revoke machines.")}
    </div>
  );
}

/**
 * One remote machine's view. The boxes view mounts the first time the
 * machine is online and stays mounted through a short outage, with a bar
 * that says it is offline; a machine never seen online shows only its state.
 */
function RemoteMachine({
  machine,
  client,
  info,
}: {
  machine: Machine;
  client: ApiClient;
  info: MachineInfo;
}) {
  const [everOnline, setEverOnline] = useState(machine.status === "online");
  useEffect(() => {
    if (machine.status === "online") setEverOnline(true);
  }, [machine.status]);
  if (!everOnline) return <MachineOffline machine={machine} />;
  return (
    <div className="bx-machine-remote">
      {machine.status !== "online" ? (
        <div role="alert" className="ab-update-bar bx-machine-offline-bar">
          {machine.name} is offline. Last seen {lastSeenText(machine)}. Its boxes and terminals come
          back when it reconnects to the hub.
        </div>
      ) : null}
      <MachineScope client={client}>
        <MachineProvider value={info}>
          <App />
        </MachineProvider>
      </MachineScope>
    </div>
  );
}

/** The page of a machine that the hub can't reach. */
export function MachineOffline({ machine }: { machine: Machine }) {
  return (
    <div className="bx-machine-offline" role="status">
      <h2>
        <StatusDot decorative state={machineDot(machine)} /> {machine.name} is{" "}
        {machineStatusLabel[machine.status].toLowerCase()}
      </h2>
      <p>Last seen {lastSeenText(machine)}.</p>
      <p className="bx-dim">
        Its boxes appear here when it connects to the hub. Check that aio-server runs on that PC and
        that it can reach this one.
      </p>
    </div>
  );
}
