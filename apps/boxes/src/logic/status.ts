// Box status: labels, dot colors, sort order, and the status-bar counts.
import type { BoxStatus, BoxView, Platform } from "@agentbox/contracts";
import type { DotState } from "@agentbox/ui";

export const statusLabel: Record<BoxStatus, string> = {
  running: "Running",
  starting: "Starting...",
  stopping: "Stopping...",
  stopped: "Not running",
};

export const statusDot: Record<BoxStatus, DotState> = {
  running: "running",
  starting: "pending",
  stopping: "pending",
  stopped: "known",
};

/** Sort rank by urgency: running first, then transitions, then stopped. */
export const statusRank: Record<BoxStatus, number> = {
  running: 0,
  starting: 1,
  stopping: 2,
  stopped: 3,
};

export const platformLabel: Record<Platform, string> = {
  claude: "Claude Code",
  codex: "Codex",
  copilot: "GitHub Copilot",
};

export const PLATFORMS: Platform[] = ["claude", "codex", "copilot"];

/** A box's display name: its conversation name, or its id without the prefix. */
export function displayName(view: BoxView): string {
  return view.box.conversationName || view.box.id.replace(/^claude-agent-/, "");
}

/**
 * The status-bar text: `N running · N not running [· N hidden by filter]`.
 * Transitional rows count as neither.
 */
export function statusBarText(all: readonly BoxView[], visibleCount: number): string {
  const running = all.filter((b) => b.status === "running").length;
  const stopped = all.filter((b) => b.status === "stopped").length;
  const parts = [`${running} running`, `${stopped} not running`];
  const hidden = all.length - visibleCount;
  if (hidden > 0) parts.push(`${hidden} hidden by filter`);
  return parts.join(" · ");
}

/** `updated HH:mm:ss` in local time. */
export function updatedText(time: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `updated ${p(time.getHours())}:${p(time.getMinutes())}:${p(time.getSeconds())}`;
}
