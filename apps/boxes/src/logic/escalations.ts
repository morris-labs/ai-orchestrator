// The escalations that wait in the Builds area. Each build's Project manager
// inbox lists the items whose pointer didn't reach the box's session and the
// escalations without an answer. The app shows a build's open escalations,
// and notifies the owner once about each escalation that didn't reach the
// session after a grace period, since the server types pointers on its own.
import { pmItemWaits, type PmItem } from "@aio/contracts";

/**
 * How long an escalation waits for its pointer to reach the Project
 * manager's session before the app notifies the owner. The server sweeps
 * every build's inbox once a minute, so a session that takes input gets the
 * pointer well within this time.
 */
export const NOTIFY_AFTER_MS = 2 * 60_000;

/** The escalations of an inbox that still wait, oldest first. */
export function openEscalations(items: readonly PmItem[]): PmItem[] {
  return items.filter((i) => i.kind === "escalation" && pmItemWaits(i));
}

/** An escalation to notify the owner about. */
export interface EscalationNotice {
  buildId: string;
  item: PmItem;
}

/** The key that marks an escalation as notified. */
export function noticeKey(buildId: string, item: Pick<PmItem, "id">): string {
  return `${buildId}/${item.id}`;
}

/**
 * The escalations to notify the owner about: each one whose pointer didn't
 * reach the session within `NOTIFY_AFTER_MS` and that isn't in `notified`.
 */
export function escalationsToNotify(
  open: ReadonlyMap<string, readonly PmItem[]>,
  notified: ReadonlySet<string>,
  now: number,
  afterMs = NOTIFY_AFTER_MS,
): EscalationNotice[] {
  const notices: EscalationNotice[] = [];
  for (const [buildId, items] of open) {
    for (const item of items) {
      if (item.deliveredAt !== null || notified.has(noticeKey(buildId, item))) continue;
      if (now - Date.parse(item.createdAt) < afterMs) continue;
      notices.push({ buildId, item });
    }
  }
  return notices;
}
