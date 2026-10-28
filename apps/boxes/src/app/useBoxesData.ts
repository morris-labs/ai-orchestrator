// The app's live data: projects, boxes, and settings, loaded through REST
// and kept current with server events. While the event stream is down, the
// data reloads every 3 seconds, as the Qt app polled.
import type { BoxView, GlobalSettings, ProjectSummary } from "@agentbox/contracts";
import { isApiError, useApiClient, useEvent, useResync, useStreamStatus } from "@agentbox/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyBoxChanged,
  applyPorts,
  applyStats,
  projectCounts,
  type ContainerStats,
} from "../logic/store";

export interface BoxesData {
  projects: ProjectSummary[];
  boxes: BoxView[];
  settings: GlobalSettings | null;
  /** Disk use per container, from `container.stats`. */
  disk: ReadonlyMap<string, number>;
  updatedAt: Date | null;
  loaded: boolean;
  /** Why the last reload failed, or `null`. */
  error: { code: string; message: string } | null;
  reload: () => Promise<void>;
  /** Replaces one box view after an action returns it. */
  putBox: (view: BoxView) => void;
  setSettings: (s: GlobalSettings) => void;
}

export function useBoxesData(): BoxesData {
  const client = useApiClient();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [boxes, setBoxes] = useState<BoxView[]>([]);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [disk, setDisk] = useState<Map<string, number>>(new Map());
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<BoxesData["error"]>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  /**
   * Box changes that arrived while a reload was in flight. The reload's
   * snapshot may predate them, so they are applied again on top of it.
   */
  const pending = useRef<Array<(boxes: BoxView[]) => BoxView[]> | null>(null);
  const status = useStreamStatus();

  /** Applies a change to the boxes now, and again after an in-flight reload. */
  const changeBoxes = useCallback((op: (boxes: BoxView[]) => BoxView[]) => {
    pending.current?.push(op);
    setBoxes(op);
  }, []);

  const reload = useCallback(() => {
    // One reload in flight at a time, as the Qt poll did.
    if (inFlight.current) return inFlight.current;
    pending.current = [];
    const p = (async () => {
      try {
        const [pr, br, st] = await Promise.all([
          client.call("projects.list", {}),
          client.call("boxes.list", {}),
          client.call("settings.get", {}),
        ]);
        setProjects(pr.projects);
        const later = pending.current ?? [];
        setBoxes(later.reduce((acc, op) => op(acc), br.boxes));
        setSettings(st);
        setError(null);
        setUpdatedAt(new Date());
      } catch (err) {
        setError({
          code: isApiError(err) ? err.code : "unreachable",
          message: err instanceof Error ? err.message : String(err),
        });
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

  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;

  useEvent("box.changed", (ev) => {
    const known = boxesRef.current.some((b) => b.box.id === ev.boxId);
    changeBoxes((all) => applyBoxChanged(all, ev).boxes);
    setUpdatedAt(new Date());
    if (known || ev.box === null) return;
    // A box this client hasn't seen: fetch its full view, and the projects,
    // since a new box can create a project.
    void client
      .call("boxes.get", { params: { boxId: ev.boxId } })
      .then((v) =>
        changeBoxes((all) => (all.some((b) => b.box.id === v.box.id) ? all : [...all, v])),
      )
      .catch(() => undefined);
    void client
      .call("projects.list", {})
      .then((r) => setProjects(r.projects))
      .catch(() => undefined);
  });
  useEvent("container.stats", (ev) => {
    changeBoxes((all) => applyStats(all, ev));
    setDisk((d) => new Map(d).set(ev.container, ev.diskBytes));
    setUpdatedAt(new Date());
  });
  useEvent("ports.changed", (ev) => {
    const proxyPort = settings?.proxyPort ?? settings?.serverPort ?? 20400;
    changeBoxes((all) => applyPorts(all, ev, proxyPort));
  });
  useEvent("settings.changed", (ev) => setSettings(ev.settings));
  useEvent("container.changed", () => {
    void client
      .call("projects.list", {})
      .then((r) => setProjects(r.projects))
      .catch(() => undefined);
  });

  const putBox = useCallback(
    (view: BoxView) =>
      changeBoxes((all) => {
        const i = all.findIndex((b) => b.box.id === view.box.id);
        if (i < 0) return [...all, view];
        const next = [...all];
        next[i] = view;
        return next;
      }),
    [changeBoxes],
  );

  const counted = useMemo(() => projectCounts(projects, boxes), [projects, boxes]);

  return {
    projects: counted,
    boxes,
    settings,
    disk,
    updatedAt,
    loaded,
    error,
    reload,
    putBox,
    setSettings,
  };
}

export type { ContainerStats };
