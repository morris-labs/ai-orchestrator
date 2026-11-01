// The Review app's machine parts: the fleet's context, the machine picker in
// the navigation, and the all-machines run table on the dashboard. Without a
// fleet, or with one machine, the app looks as it does on a single machine.
import { LOCAL_MACHINE_ID } from "@aio/contracts";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import {
  fleetRuns,
  isMulti,
  type FleetMachine,
  type FleetState,
  type MachineFleet,
} from "../state/fleet.js";
import { href, navigate } from "../state/router.js";
import { RunStatusBadge, shortId } from "./common.js";

const FleetContext = createContext<MachineFleet | null>(null);

export function FleetProvider({ fleet, children }: { fleet: MachineFleet; children: ReactNode }) {
  return <FleetContext.Provider value={fleet}>{children}</FleetContext.Provider>;
}

/** The fleet, or `null` in a single-machine tree such as a screen test. */
export function useFleet(): MachineFleet | null {
  return useContext(FleetContext);
}

const NO_FLEET: FleetState = {
  supported: false,
  machines: [],
  selected: LOCAL_MACHINE_ID,
  error: null,
};
const noSubscribe = () => () => undefined;

/** The fleet's state; one local machine without a fleet. */
export function useFleetState(): FleetState {
  const fleet = useFleet();
  return useSyncExternalStore(fleet?.subscribe ?? noSubscribe, () =>
    fleet ? fleet.getState() : NO_FLEET,
  );
}

/** The name of the machine with `id`, for labels. */
export function machineName(state: FleetState, id: string): string {
  return state.machines.find((m) => m.machine.id === id)?.machine.name ?? id;
}

const REACH_LABEL: Record<FleetMachine["reach"], string> = {
  loading: "Loading",
  online: "Online",
  offline: "Offline",
  error: "Error",
};

/** The option text of a machine: its name, with this PC or a state that isn't online. */
function optionText(m: FleetMachine): string {
  if (m.machine.isLocal) return `${m.machine.name} (this PC)`;
  if (m.reach === "offline" || m.reach === "error") {
    return `${m.machine.name} (${REACH_LABEL[m.reach].toLowerCase()})`;
  }
  return m.machine.name;
}

/**
 * Picks the machine the screens show. A run, a project, and a box belong to
 * one machine, so a switch leaves a run's view for the run list and drops
 * the route's query.
 */
export function MachinePicker({ onSwitch }: { onSwitch?: () => void }) {
  const fleet = useFleet();
  const state = useFleetState();
  if (!fleet || !isMulti(state)) return null;
  return (
    <label className="machine-picker">
      <span>Machine</span>
      <select
        value={state.selected}
        onChange={(e) => {
          // Leave a machine's run first, so the next machine's screens
          // mount on the plain route.
          onSwitch?.();
          fleet.select(e.target.value);
        }}
      >
        {state.machines.map((m) => (
          <option key={m.machine.id} value={m.machine.id}>
            {optionText(m)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Opens a run on its machine. */
export function openRun(fleet: MachineFleet | null, machineId: string, runId: string): void {
  fleet?.select(machineId);
  navigate(href(`/runs/${runId}`));
}

/**
 * Every machine's runs in one table with a Machine column, and a note for
 * each machine that can't answer. Renders nothing on a single machine.
 */
export function FleetRuns() {
  const fleet = useFleet();
  const state = useFleetState();
  if (!fleet || !isMulti(state)) return null;
  const runs = fleetRuns(state);
  const away = state.machines.filter((m) => m.reach === "offline" || m.reach === "error");
  return (
    <section className="card fleet-runs" aria-label="Runs on every machine">
      <h3>Runs on every machine</h3>
      {away.length > 0 ? (
        <ul className="machine-notes" aria-label="Machines without a current list">
          {away.map((m) => (
            <li key={m.machine.id}>
              <span
                className={`ab-status ab-tone-${m.reach === "offline" ? "warning" : "critical"}`}
              >
                {m.machine.name}: {REACH_LABEL[m.reach]}
              </span>{" "}
              <span className="muted small">
                {m.error}
                {m.runs.length > 0 && m.loadedAt
                  ? ` Its runs are as of ${new Date(m.loadedAt).toLocaleString()}.`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {state.error ? <p className="muted small">{state.error}</p> : null}
      {runs.length === 0 ? (
        <p className="muted">No runs on any machine.</p>
      ) : (
        <table className="ab-table">
          <thead>
            <tr>
              <th scope="col">Machine</th>
              <th scope="col">Run</th>
              <th scope="col">Status</th>
              <th scope="col">Stage</th>
              <th scope="col">Repository</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={`${r.machineId}/${r.run.id}`}>
                <td>
                  {r.machineName}
                  {r.reach === "offline" || r.reach === "error" ? (
                    <span className="muted small"> ({REACH_LABEL[r.reach].toLowerCase()})</span>
                  ) : null}
                </td>
                <td>
                  <a
                    className="mono"
                    href={href(`/runs/${r.run.id}`)}
                    onClick={(e) => {
                      e.preventDefault();
                      openRun(fleet, r.machineId, r.run.id);
                    }}
                  >
                    {shortId(r.run.id)}
                  </a>
                </td>
                <td>
                  <RunStatusBadge status={r.run.status} />
                </td>
                <td>{r.run.stage}</td>
                <td className="mono">{r.run.request.repoPath}</td>
                <td>{new Date(r.run.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
