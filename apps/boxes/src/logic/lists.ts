// The lists that confirmations show: what Resume, Restart All, and Purge
// act on.
import type { BoxView } from "@agentbox/contracts";

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

/** Claude Code's transcript directory name for a path: every byte other than a letter or digit becomes `-`. */
export function encodeProjectDir(path: string): string {
  return path.replace(/[^0-9A-Za-z]/g, "-");
}

/** A box running against the same directory, which makes Purge refuse. Looks at every box, not the filtered ones. */
export function runningOnDir(all: readonly BoxView[], dir: string): BoxView | undefined {
  return all.find((b) => b.status === "running" && b.box.targetDir === dir);
}

/** What Purge removes, for its confirmation: records and transcript directories. */
export function purgeList(all: readonly BoxView[], dir: string): string[] {
  const out = [`~/.claude/projects/${encodeProjectDir(dir)}`];
  for (const b of all.filter((x) => x.box.targetDir === dir)) {
    out.push(`the record of ${b.box.id}`);
    if (b.box.worktree) {
      const wt = `~/.claude/projects/${encodeProjectDir(b.box.worktree)}`;
      if (!out.includes(wt)) out.push(wt);
    }
  }
  return out;
}
