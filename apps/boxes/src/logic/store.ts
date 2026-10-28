// Applies server events to the app's box list. `box.changed` carries the
// record and the status; `container.stats` and `ports.changed` are per
// container, so they update every box that runs in that container.
import type { BoxView, EventOf, Listener, ProjectSummary } from "@agentbox/contracts";

export interface ContainerStats {
  cpuPercent: number;
  memBytes: number;
  memLimitBytes: number;
  diskBytes: number;
}

/**
 * Applies `box.changed`. Returns the new list and whether the box is unknown
 * here, in which case the caller fetches its full view.
 */
export function applyBoxChanged(
  boxes: readonly BoxView[],
  ev: EventOf<"box.changed">,
): { boxes: BoxView[]; unknown: boolean } {
  if (ev.box === null) return { boxes: boxes.filter((b) => b.box.id !== ev.boxId), unknown: false };
  const i = boxes.findIndex((b) => b.box.id === ev.boxId);
  if (i < 0) return { boxes: [...boxes], unknown: true };
  const next = [...boxes];
  const old = next[i] as BoxView;
  next[i] = { ...old, box: ev.box, status: ev.status, container: ev.box.container };
  return { boxes: next, unknown: false };
}

/** Applies `container.stats` to every box in the container. */
export function applyStats(boxes: readonly BoxView[], ev: EventOf<"container.stats">): BoxView[] {
  return boxes.map((b) =>
    b.container === ev.container
      ? {
          ...b,
          stats: {
            cpuPercent: ev.cpuPercent,
            memBytes: ev.memBytes,
            memLimitBytes: ev.memLimitBytes,
          },
        }
      : b,
  );
}

/** The dev-server proxy URL for a port of a box: `http://<port>.<hostKey>.localhost:<proxyPort>/`. */
export function proxyUrl(port: number, hostKey: string, proxyPort: number): string {
  return `http://${port}.${hostKey}.localhost:${proxyPort}/`;
}

/**
 * The listeners a box shows: the ones its session owns, plus the ones the
 * engine can't attribute when the box is the only one in its container.
 */
export function listenersForBox(
  view: BoxView,
  all: readonly Listener[],
  boxesInContainer: number,
): Listener[] {
  return all.filter((l) => l.boxId === view.box.id || (l.boxId === null && boxesInContainer <= 1));
}

/** Applies `ports.changed`: new listeners and proxy links for every box in the container. */
export function applyPorts(
  boxes: readonly BoxView[],
  ev: EventOf<"ports.changed">,
  proxyPort: number,
): BoxView[] {
  const inContainer = boxes.filter((b) => b.container === ev.container).length;
  return boxes.map((b) => {
    if (b.container !== ev.container) return b;
    const listeners = listenersForBox(b, ev.listeners, inContainer);
    const ports = [...new Set(listeners.map((l) => l.port))].sort((x, y) => x - y);
    return {
      ...b,
      listeners,
      proxyUrls: ports.map((port) => ({ port, url: proxyUrl(port, b.box.hostKey, proxyPort) })),
    };
  });
}

/** Project rows with running and total counts recomputed from the live box list. */
export function projectCounts(
  projects: readonly ProjectSummary[],
  boxes: readonly BoxView[],
): ProjectSummary[] {
  return projects.map((p) => {
    const mine = boxes.filter((b) => b.box.projectId === p.project.id);
    return { ...p, running: mine.filter((b) => b.status === "running").length, total: mine.length };
  });
}

/** Overlays optimistic transitions ("Starting...", "Stopping...") until the server confirms. */
export function withTransient(
  boxes: readonly BoxView[],
  transient: ReadonlyMap<string, BoxView["status"]>,
): BoxView[] {
  if (transient.size === 0) return [...boxes];
  return boxes.map((b) => {
    const t = transient.get(b.box.id);
    return t ? { ...b, status: t } : b;
  });
}

/**
 * Drops the optimistic overlay of a box once the server reports progress on
 * that transition: `starting` or `running` for a start, `stopping` or
 * `stopped` for a stop. The row then shows the server's state, even if the
 * request that set the overlay never settles.
 */
export function settleTransient(
  transient: ReadonlyMap<string, BoxView["status"]>,
  boxId: string,
  status: BoxView["status"],
): ReadonlyMap<string, BoxView["status"]> {
  const t = transient.get(boxId);
  if (t === undefined) return transient;
  const settles =
    t === "starting"
      ? status === "starting" || status === "running"
      : t === "stopping"
        ? status === "stopping" || status === "stopped"
        : t === status;
  if (!settles) return transient;
  const next = new Map(transient);
  next.delete(boxId);
  return next;
}
