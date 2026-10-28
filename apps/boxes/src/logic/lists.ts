// The lists that confirmations show: what Resume, Restart All, and Purge
// act on.
import { normalizeDir } from "./newBox";
import type { BoxView, PurgeResult } from "@agentbox/contracts";

/**
 * Boxes to offer after a reboot: none when any box runs (the app was only
 * restarted), else the stopped boxes that were running before.
 */
export function resumableBoxes(all: readonly BoxView[]): BoxView[] {
  if (all.some((b) => b.status === "running")) return [];
  return all.filter((b) => b.status === "stopped" && b.box.wasRunning);
}

/** The Resume prompt's detail, as the Qt app worded it. */
export function resumeDetail(ids: readonly string[]): string {
  return ids.length === 1
    ? `1 box was running before the last shutdown:\n\n  ${ids[0]}`
    : `${ids.length} boxes were running before the last shutdown:\n\n  ${ids.join("\n  ")}`;
}

/**
 * A box running, starting, or stopping against the same directory, which
 * makes Purge refuse. Looks at every box, not the filtered ones; trailing
 * slashes don't count.
 */
export function runningOnDir(all: readonly BoxView[], dir: string): BoxView | undefined {
  const d = normalizeDir(dir);
  return all.find((b) => b.status !== "stopped" && normalizeDir(b.box.targetDir) === d);
}

/** What Purge removes, for its confirmation, from the server's dry run: transcript folders, then records. */
export function purgePreviewList(preview: PurgeResult): string[] {
  return [
    ...preview.removedTranscriptDirs,
    ...preview.removedRecords.map((id) => `the record of ${id}`),
  ];
}
