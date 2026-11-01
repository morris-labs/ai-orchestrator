// The machine list from the hub, reloaded every 10 seconds so that the
// tabs follow machines that come online, go offline, or are revoked.
import type { Machine } from "@aio/contracts";
import type { ApiClient } from "@aio/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { listMachines, machinesUnsupported } from "../logic/machines";

export interface MachinesState {
  /** `null` until the first answer; false when the server has no machine routes. */
  supported: boolean | null;
  /** The machines, this server's first; empty until loaded or when unsupported. */
  machines: Machine[];
  /** Why the last reload failed, or `null`. The last good list stays in place. */
  error: string | null;
  reload: () => Promise<void>;
}

export const MACHINES_POLL_MS = 10_000;

export function useMachines(client: ApiClient, pollMs = MACHINES_POLL_MS): MachinesState {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const unsupported = useRef(false);

  const reload = useCallback(async () => {
    if (unsupported.current) return;
    try {
      setMachines(await listMachines(client));
      setSupported(true);
      setError(null);
    } catch (err) {
      if (machinesUnsupported(err)) {
        // An older server: one machine, as before, and no more polling.
        unsupported.current = true;
        setSupported(false);
        setMachines([]);
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);

  useEffect(() => {
    void reload();
    const t = setInterval(() => void reload(), pollMs);
    return () => clearInterval(t);
  }, [reload, pollMs]);

  return { supported, machines, error, reload };
}
