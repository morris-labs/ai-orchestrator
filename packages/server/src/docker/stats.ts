// CPU percentage from one-shot stats samples. The CPU figure is a rate, so it
// needs the previous sample of the same container; docker's own formula.
import type { StatsSample } from "./types.js";

export interface ContainerStats {
  /** `null` until a second sample exists. */
  cpuPercent: number | null;
  /** Memory in use, excluding the inactive file cache, as `docker stats` reports it. */
  memBytes: number;
  memLimitBytes: number;
}

export class CpuTracker {
  private readonly previous = new Map<string, StatsSample>();

  /** Computes the figures for `sample` and keeps it as the next baseline. */
  update(id: string, sample: StatsSample): ContainerStats {
    const prev = this.previous.get(id);
    let cpuPercent: number | null = null;
    if (
      prev &&
      sample.systemCpuUsage > prev.systemCpuUsage &&
      sample.cpuTotalUsage >= prev.cpuTotalUsage
    ) {
      const containerDelta = sample.cpuTotalUsage - prev.cpuTotalUsage;
      const systemDelta = sample.systemCpuUsage - prev.systemCpuUsage;
      cpuPercent = (containerDelta / systemDelta) * (sample.onlineCpus || 1) * 100;
    }
    this.previous.set(id, sample);
    const memBytes =
      sample.memUsage > sample.memInactiveFile
        ? sample.memUsage - sample.memInactiveFile
        : sample.memUsage;
    return { cpuPercent, memBytes, memLimitBytes: sample.memLimit };
  }

  /** Drops a container's baseline, so a failed sample cannot span two intervals. */
  forget(id: string): void {
    this.previous.delete(id);
  }
}
