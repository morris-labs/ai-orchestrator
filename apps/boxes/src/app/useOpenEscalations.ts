// The open escalations of the machine's active builds, from each build's
// Project manager inbox. A `build.inbox` or `build.changed` event reloads
// that build's inbox, a resync reloads every inbox, and a poll reloads them
// every 30 seconds, since the server marks an item delivered or answered
// without an event.
import type { BuildSummary, PmItem } from "@aio/contracts";
import { useApiClient, useEvent, useResync } from "@aio/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isBuildActive } from "../logic/builds";
import { openEscalations } from "../logic/escalations";

/** How often the app reloads the inboxes of the active builds. */
export const INBOX_POLL_MS = 30_000;

/** Open escalations by build id, oldest first; a build without any has no entry. */
export type OpenEscalations = ReadonlyMap<string, readonly PmItem[]>;

export function useOpenEscalations(builds: readonly BuildSummary[]): OpenEscalations {
  const client = useApiClient();
  const [byBuild, setByBuild] = useState<OpenEscalations>(new Map());
  const activeIds = useMemo(
    () =>
      builds
        .filter(isBuildActive)
        .map((b) => b.id)
        .sort(),
    [builds],
  );
  const activeKey = activeIds.join(",");
  const active = useRef<readonly string[]>(activeIds);
  active.current = activeIds;
  /** The latest load of each build; an older load's answer is dropped. */
  const loads = useRef(new Map<string, number>());

  const load = useCallback(
    async (buildId: string) => {
      const n = (loads.current.get(buildId) ?? 0) + 1;
      loads.current.set(buildId, n);
      let items: PmItem[];
      try {
        const inbox = await client.call("builds.inbox", { params: { buildId } });
        items = openEscalations(inbox.items);
      } catch {
        // The engine runs only while the project's container does; keep
        // what the last load found.
        return;
      }
      if (loads.current.get(buildId) !== n) return;
      setByBuild((current) => {
        const next = new Map(current);
        if (items.length > 0 && active.current.includes(buildId)) next.set(buildId, items);
        else next.delete(buildId);
        return next;
      });
    },
    [client],
  );

  const loadAll = useCallback(() => {
    for (const id of active.current) void load(id);
  }, [load]);

  // A build that is no longer active drops its escalations; a new one loads.
  useEffect(() => {
    const ids = activeKey === "" ? [] : activeKey.split(",");
    setByBuild((current) => {
      const next = new Map([...current].filter(([id]) => ids.includes(id)));
      return next.size === current.size ? current : next;
    });
    for (const id of ids) void load(id);
  }, [activeKey, load]);

  useEffect(() => {
    const t = setInterval(loadAll, INBOX_POLL_MS);
    return () => clearInterval(t);
  }, [loadAll]);

  useResync(loadAll);

  useEvent("build.inbox", (ev) => {
    if (active.current.includes(ev.buildId)) void load(ev.buildId);
  });

  useEvent("build.changed", (ev) => {
    if (active.current.includes(ev.build.id)) void load(ev.build.id);
  });

  return byBuild;
}
