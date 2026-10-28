// Writes the active-run count to `$STATE/active-runs` once a second. The
// keeper reads it so the container stays up while a run is in progress.
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "../api/core-interface.js";

/** Writes `count` to `<dir>/active-runs` atomically. Returns false when the write fails. */
export function writeActiveRuns(dir: string, count: number): boolean {
  const file = path.join(dir, "active-runs");
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, `${count}\n`);
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export interface ActiveRunsWriter {
  stop(finalCount?: number): void;
}

/** Starts the once-a-second writer. */
export function startActiveRunsWriter(
  dir: string,
  count: () => number,
  log: Logger,
  intervalMs = 1_000,
): ActiveRunsWriter {
  let warned = false;
  const tick = () => {
    let n = 0;
    try {
      n = count();
    } catch (err) {
      log.warn("Couldn't count active runs", { error: String(err) });
    }
    if (!writeActiveRuns(dir, n) && !warned) {
      warned = true;
      log.warn("Couldn't write the active-runs file; the keeper treats that as zero", { dir });
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return {
    stop(finalCount) {
      clearInterval(timer);
      if (finalCount !== undefined) writeActiveRuns(dir, finalCount);
    },
  };
}
