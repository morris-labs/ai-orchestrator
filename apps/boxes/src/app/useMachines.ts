// The machine list from the hub, reloaded every 10 seconds so that the
// tabs follow machines that come online, go offline, or are revoked.
import type { Machine } from "@aio/contracts";
import type { ApiClient } from "@aio/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { listMachines, machinesUnsupported } from "../logic/machines";

export interface MachinesState {
  /**
   * `null` until the first answer; false while the server has no machine
   * routes. Polling goes on, so an upgraded server turns this true.
   */
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
  // The client that has answered with a list. Its machine routes exist, so a
  // later 404, 405, or 501 comes from a proxy or a restart, not an older server.
  const listedBy = useRef<ApiClient | null>(null);

  const reload = useCallback(async () => {
    try {
      setMachines(await listMachines(client));
      listedBy.current = client;
      setSupported(true);
      setError(null);
    } catch (err) {
      if (machinesUnsupported(err) && listedBy.current !== client) {
        // An older server: one machine, as before, until an upgrade adds the routes.
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
