// Review runs across the machines of a multi-host setup: `aio review status
// --all-machines` lists every machine's runs, and another machine that can't
// answer shows as offline instead of failing the whole list.
import type { Machine, RunState } from "@aio/contracts";
import { ApiCallError, type ServerClient } from "./client.js";
import { table } from "./format.js";

/** The error codes that mean a machine can't be reached through the hub. */
const UNREACHABLE_CODES = new Set(["machine_offline", "machine_timeout", "hub_unreachable"]);

/** A machine of the fleet, as the CLI's machine list gives it. */
export type FleetMachine = Pick<Machine, "id" | "name" | "isLocal" | "status">;

/** One machine's part of an all-machines run list. */
export interface FleetMachineRuns {
  /** The machine ID; `local` for the server the CLI talks to. */
  id: string;
  name: string;
  /** `online` when the list came back, `offline` when the machine can't answer, else `error`. */
  status: "online" | "offline" | "error";
  /** Why the machine has no list, or `null`. */
  error: string | null;
  runs: RunState[];
}

/**
 * Lists the runs of each machine in `machines`, which must hold this one
 * first and no revoked machine. The calls run in parallel; a machine the
 * hub reports offline gets no call, and another machine that answers with an
 * API error gets that error instead of runs. `clientFor` gives the client for
 * a machine.
 *
 * @throws Any failure of this server's own call, and any failure that isn't an
 *   API error, such as an interrupt or an unreachable server. Every call goes
 *   through this server, so those failures aren't one machine's.
 */
export async function listFleetRuns(
  machines: FleetMachine[],
  clientFor: (machine: FleetMachine) => ServerClient,
  query: { projectId?: string; boxId?: string },
): Promise<FleetMachineRuns[]> {
  return Promise.all(
    machines.map(async (m): Promise<FleetMachineRuns> => {
      const base = { id: m.id, name: m.name };
      if (!m.isLocal && m.status !== "online") {
        return { ...base, status: "offline", error: "The hub reports it offline.", runs: [] };
      }
      try {
        const { runs } = await clientFor(m).call("runs.list", { query });
        return { ...base, status: "online", error: null, runs };
      } catch (err) {
        if (m.isLocal || !(err instanceof ApiCallError)) throw err;
        return {
          ...base,
          status: UNREACHABLE_CODES.has(err.code) ? "offline" : "error",
          error: err.message,
          runs: [],
        };
      }
    }),
  );
}

/** The text form: one table of every run, newest first, then a line per machine without a list. */
export function fleetRunText(fleet: FleetMachineRuns[]): string {
  const rows = fleet
    .flatMap((m) => m.runs.map((r) => ({ machine: m.name, run: r })))
    .sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt))
    .map(({ machine, run: r }) => [
      machine,
      r.id,
      r.status,
      r.stage,
      r.round,
      r.profile,
      r.boxId,
      r.updatedAt,
    ]);
  const notes = fleet
    .filter((m) => m.status !== "online")
    .map((m) => `${m.name}: ${m.status}. ${m.error ?? ""}`.trimEnd() + "\n");
  const head =
    rows.length === 0
      ? "No runs on any machine.\n"
      : table(["MACHINE", "RUN", "STATUS", "STAGE", "ROUND", "PROFILE", "BOX", "UPDATED"], rows);
  return head + (notes.length > 0 ? `\n${notes.join("")}` : "");
}
