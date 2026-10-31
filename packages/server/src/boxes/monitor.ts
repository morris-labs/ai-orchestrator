// The poll that keeps the apps current (3.3.5's 3-second refresh): container
// states, container stats with the CPU delta, box status changes, and the
// `was_running` rule for sessions that end on their own.
import { EventEmitter } from "node:events";
import { CONTAINER_PREFIX, type BoxStatus, type ContainerState } from "@agentbox/contracts";
import type { Repositories } from "../db/repositories.js";
import { LABELS } from "../docker/launch.js";
import { STATE_MAX_AGE_SEC } from "../docker/state.js";
import { CpuTracker } from "../docker/stats.js";
import {
  DockerUnavailableError,
  type ContainerSummary,
  type DockerClient,
} from "../docker/types.js";
import type { CoreEvents } from "../records/events.js";
import type { BoxService } from "./service.js";

export interface ContainerStatsSnapshot {
  cpuPercent: number;
  memBytes: number;
  memLimitBytes: number;
  diskBytes: number;
}

/** Emitted as `"boxEnded"` when a running box's session goes away. */
export interface BoxEndedEvent {
  boxId: string;
  /** True when nobody asked for the stop and it doesn't look like a Docker restart. */
  unexpected: boolean;
}

const PROJECT_PREFIX = `${CONTAINER_PREFIX}proj-`;

/**
 * How often a container's writable-layer size is measured. Docker walks the
 * whole layer for it, so the routine poll reuses the last figure.
 */
export const DISK_SIZE_INTERVAL_MS = 60_000;

function stateOf(c: ContainerSummary | undefined): ContainerState {
  if (!c) return "removed";
  if (c.state === "running") return "running";
  return c.state === "created" ? "created" : "exited";
}

/**
 * Whether a drop of running boxes looks like a Docker engine restart rather
 * than sessions ending: the daemon was unreachable, or at least two boxes ran
 * and at least half of them dropped at once. `was_running` survives those.
 */
export function looksLikeEngineRestart(
  daemonUnreachable: boolean,
  runningBefore: number,
  dropped: number,
): boolean {
  return daemonUnreachable || (runningBefore >= 2 && dropped * 2 >= runningBefore);
}

export class ContainerMonitor extends EventEmitter {
  private readonly cpu = new CpuTracker();
  private readonly stats = new Map<string, ContainerStatsSnapshot>();
  private readonly disk = new Map<string, { bytes: number; at: number }>();
  private readonly containerStates = new Map<string, ContainerState>();
  private readonly boxStatuses = new Map<string, BoxStatus>();
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private firstPoll = true;
  private lastPollAt: number | undefined;

  constructor(
    private readonly deps: {
      repos: Repositories;
      docker: DockerClient;
      events: CoreEvents;
      boxes: BoxService;
      /** Called with the running box ids after every poll (the session watcher). */
      onRunning?: (boxIds: string[]) => void | Promise<void>;
      /** The clock, in milliseconds; the host's clock unless a test sets one. */
      now?: () => number;
      /** Overrides `DISK_SIZE_INTERVAL_MS`. */
      diskSizeIntervalMs?: number;
    },
  ) {
    super();
  }

  /** The last stats sample of a container, or `null`. */
  statsFor(container: string): ContainerStatsSnapshot | null {
    return this.stats.get(container) ?? null;
  }

  /** Starts polling every `intervalMs`. The first poll skips stats, as 3.3.5 did. */
  start(intervalMs = 3000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll().catch(() => undefined), intervalMs);
    this.timer.unref?.();
    void this.poll().catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll; overlapping calls share the poll in flight. */
  poll(options: { sampleStats?: boolean } = {}): Promise<void> {
    if (!this.polling) {
      const sample = options.sampleStats ?? !this.firstPoll;
      this.firstPoll = false;
      this.polling = this.pollOnce(sample).finally(() => {
        this.polling = undefined;
      });
    }
    return this.polling;
  }

  private async pollOnce(sampleStats: boolean): Promise<void> {
    const { docker, events, repos, boxes } = this.deps;
    // After a gap longer than a sessions file stays fresh, as when the host
    // wakes from suspend, every keeper's file looks stale until the keepers
    // rewrite it. A box that seems to have stopped then is checked again on
    // the next poll rather than reported as ended.
    const now = this.now();
    const resumed =
      this.lastPollAt !== undefined && now - this.lastPollAt > STATE_MAX_AGE_SEC * 1000;
    this.lastPollAt = now;
    let containers: ContainerSummary[] = [];
    let unreachable = false;
    try {
      containers = await docker.listContainers({ all: true, nameRegex: `^${PROJECT_PREFIX}` });
    } catch (err) {
      if (!(err instanceof DockerUnavailableError)) throw err;
      unreachable = true;
    }

    if (!unreachable) {
      const byName = new Map(containers.map((c) => [c.name, c]));
      const names = new Set([...byName.keys(), ...this.containerStates.keys()]);
      for (const p of repos.projects.list()) names.add(`${PROJECT_PREFIX}${p.id}`);
      for (const name of names) {
        const c = byName.get(name);
        const state = stateOf(c);
        const projectId = c?.labels[LABELS.project] ?? name.slice(PROJECT_PREFIX.length);
        if (
          this.containerStates.get(name) !== state &&
          !(state === "removed" && !this.containerStates.has(name))
        ) {
          events.publish({
            type: "container.changed",
            container: name,
            projectId,
            state,
            engine: null,
          });
        }
        this.containerStates.set(name, state);
        if (state !== "running") {
          this.stats.delete(name);
          this.disk.delete(name);
          this.cpu.forget(name);
        }
      }
      if (sampleStats) {
        const runningContainers = containers.filter((x) => x.state === "running");
        for (const c of runningContainers) {
          await this.sample(c);
        }
        // A container that left the list entirely is never named above.
        this.cpu.retain(runningContainers.map((c) => c.name));
      }
    }

    const all = repos.boxes.list();
    const runningBefore = [...this.boxStatuses.values()].filter((s) => s === "running").length;
    const ended: string[] = [];
    const running: string[] = [];
    for (const box of all) {
      const status = boxes.status(box);
      const prev = this.boxStatuses.get(box.id);
      if (resumed && (prev === "running" || prev === "stopping") && status === "stopped") continue;
      if (status === "running") running.push(box.id);
      if ((prev === "running" || prev === "stopping") && status === "stopped") ended.push(box.id);
      if (prev !== undefined && prev !== status) {
        events.publish({ type: "box.changed", boxId: box.id, status, box });
      }
      this.boxStatuses.set(box.id, status);
    }
    for (const id of [...this.boxStatuses.keys()]) {
      if (!all.some((b) => b.id === id)) this.boxStatuses.delete(id);
    }

    const engineRestart = looksLikeEngineRestart(unreachable, runningBefore, ended.length);
    for (const id of ended) {
      const requested = boxes.takeRequestedStop(id);
      if (!requested && !engineRestart) {
        const box = repos.boxes.get(id);
        if (box?.wasRunning) repos.boxes.put({ ...box, wasRunning: false });
      }
      // A Docker daemon restart ends every session at once; that is not one
      // session ending unexpectedly per box.
      this.emit("boxEnded", {
        boxId: id,
        unexpected: !requested && !engineRestart,
      } satisfies BoxEndedEvent);
    }
    await this.deps.onRunning?.(running);
  }

  private async sample(c: ContainerSummary): Promise<void> {
    const { docker, events } = this.deps;
    let raw;
    try {
      raw = await docker.stats(c.id);
    } catch {
      raw = null;
    }
    if (!raw) {
      this.cpu.forget(c.name);
      return;
    }
    const figures = this.cpu.update(c.name, raw);
    const snapshot: ContainerStatsSnapshot = {
      cpuPercent: figures.cpuPercent ?? 0,
      memBytes: Math.round(figures.memBytes),
      memLimitBytes: Math.round(figures.memLimitBytes),
      diskBytes: await this.diskBytes(c),
    };
    this.stats.set(c.name, snapshot);
    if (figures.cpuPercent === null) return;
    events.publish({
      type: "container.stats",
      container: c.name,
      projectId: c.labels[LABELS.project] ?? c.name.slice(PROJECT_PREFIX.length),
      ...snapshot,
    });
  }

  /** The container's writable-layer size, measured at most every `diskSizeIntervalMs`. */
  private async diskBytes(c: ContainerSummary): Promise<number> {
    const now = this.now();
    const last = this.disk.get(c.name);
    const interval = this.deps.diskSizeIntervalMs ?? DISK_SIZE_INTERVAL_MS;
    if (last && now - last.at < interval) return last.bytes;
    const inspect = await this.deps.docker.inspectContainer(c.id, { size: true }).catch(() => null);
    if (inspect?.sizeRw === undefined) return last?.bytes ?? 0;
    const bytes = Math.round(inspect.sizeRw);
    this.disk.set(c.name, { bytes, at: now });
    return bytes;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
