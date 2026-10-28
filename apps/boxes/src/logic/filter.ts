// The box filter: a case-insensitive substring match on the status, the
// directory, the conversation, and the container name. 3.3.5 never matched
// container names (inventory section 0, item 4); 4.0.0 does.
import type { BoxView } from "@agentbox/contracts";
import { displayName, statusLabel } from "./status";

export function matchesFilter(view: BoxView, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return true;
  const haystack = [
    statusLabel[view.status],
    view.box.targetDir,
    view.box.worktree ?? "",
    displayName(view),
    view.box.id,
    view.container,
  ];
  return haystack.some((h) => h.toLowerCase().includes(needle));
}

/** Boxes in the selected project (or all when `projectId` is null) that match the filter. */
export function visibleBoxes(
  all: readonly BoxView[],
  projectId: string | null,
  filter: string,
): BoxView[] {
  return all.filter(
    (b) => (projectId === null || b.box.projectId === projectId) && matchesFilter(b, filter),
  );
}
