// Review runs across the machines of a multi-host setup: `aio review status
// --all-machines` lists every machine's runs, and a machine that can't
// answer shows as offline instead of failing the whole list.
import type { Machine, RunState } from "@aio/contracts";
import { ApiCallError, ServerUnreachableError, type ServerClient } from "./client.js";
import { table } from "./format.js";

/** The error codes that mean a machine can't be reached through the hub. */
const UNREACHABLE_CODES = new Set(["machine_offline", "machine_timeout", "hub_unreachable"]);

/** The message for a relative `--repo` with `--machine`. */
export const REMOTE_REPO_MESSAGE =
  "With --machine, give --repo as an absolute path on that machine, or give --box.";

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

/** True for a Windows path such as `C:\Users\NAME\project` or `C:/src`. */
export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p);
}

/** True for a machine that gets a run list: this one, or an enrolled one that isn't revoked. */
function listed(m: Machine): boolean {
  return m.isLocal || m.status === "online" || m.status === "offline";
}

/**
 * Lists the runs of every machine that `local` knows, this one first. The
 * calls run in parallel; a machine the hub reports offline gets no call,
 * and one that fails gets its error instead of runs.
 */
export async function listFleetRuns(
  local: ServerClient,
  clientFor: (machineId: string) => ServerClient,
  query: { projectId?: string; boxId?: string },
): Promise<FleetMachineRuns[]> {
  const { machines } = await local.call("machines.list");
  const shown = machines.filter(listed);
  return Promise.all(
    shown.map(async (m): Promise<FleetMachineRuns> => {
      const base = { id: m.id, name: m.name };
      if (!m.isLocal && m.status === "offline") {
        return { ...base, status: "offline", error: "The hub reports it offline.", runs: [] };
      }
      try {
        const c = m.isLocal ? local : clientFor(m.id);
        const { runs } = await c.call("runs.list", { query });
        return { ...base, status: "online", error: null, runs };
      } catch (err) {
        const unreachable =
          (err instanceof ApiCallError && UNREACHABLE_CODES.has(err.code)) ||
          err instanceof ServerUnreachableError;
        return {
          ...base,
          status: unreachable ? "offline" : "error",
          error: err instanceof Error ? err.message : String(err),
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
