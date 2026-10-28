// Values derived from a stored box record (inventory section 3.1).
import { deriveHostKey, type Box, type Platform } from "@agentbox/contracts";

/**
 * The tmux session name for a stored `session` value. tmux rewrites `.` and
 * `:` in session names to `_`, so every tmux command and state-file
 * comparison uses this form; the record keeps the name as written.
 */
export function tmuxSessionName(session: string): string {
  return (session || "main").replace(/[.:]/g, "_");
}

/** The tmux session a box's main CLI runs in. */
export function boxTmuxSession(box: Pick<Box, "session">): string {
  return tmuxSessionName(box.session);
}

/** The tmux session a side CLI runs in: `<tmuxSession>-<platform>`. */
export function sideSessionName(box: Pick<Box, "session">, platform: Platform): string {
  return `${boxTmuxSession(box)}-${platform}`;
}

/** The platforms a box can run, in menu order. */
export const PLATFORMS: readonly Platform[] = ["claude", "codex", "copilot"];

/**
 * Returns a `hostKey` for `boxId` that no other box in `siblings` uses. Pass
 * every box: the proxy resolves `<port>.<hostKey>.localhost` across all
 * projects, so the server keeps keys unique globally, a stricter rule than
 * the contract's "unique within a project".
 */
export function allocateHostKey(
  boxId: string,
  siblings: readonly Pick<Box, "id" | "hostKey">[],
): string {
  const taken = new Set(siblings.filter((b) => b.id !== boxId).map((b) => b.hostKey));
  return deriveHostKey(boxId, taken);
}
