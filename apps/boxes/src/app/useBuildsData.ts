// The machine's builds, loaded through REST and kept current with
// `build.changed` events. While the event stream is down, the list reloads
// every 3 seconds, as the box list does.
import type { BuildSummary } from "@aio/contracts";
import { useApiClient, useEvent, useResync, useStreamStatus } from "@aio/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyBuildChanged } from "../logic/builds";

export interface BuildsData {
  /** Newest first. */
  builds: BuildSummary[];
  loaded: boolean;
  /** Why the last load failed, or `null`. */
  error: string | null;
  reload: () => Promise<void>;
}

export function useBuildsData(): BuildsData {
  const client = useApiClient();
  const [builds, setBuilds] = useState<BuildSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = useStreamStatus();
  /**
   * Builds that changed while a load was in flight. The load's snapshot may
   * predate them, so they apply again on top of it.
   */
  const pending = useRef<BuildSummary[] | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const reload = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    pending.current = [];
    const p = (async () => {
      try {
        const r = await client.call("builds.list", {});
        const later = pending.current ?? [];
        setBuilds(later.reduce(applyBuildChanged, r.builds));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoaded(true);
        pending.current = null;
        inFlight.current = null;
      }
    })();
    inFlight.current = p;
    return p;
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (status === "open") return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [status, reload]);

  useResync(() => void reload());

  useEvent("build.changed", (ev) => {
    pending.current?.push(ev.build);
    setBuilds((all) => applyBuildChanged(all, ev.build));
  });

  return { builds, loaded, error, reload };
}
