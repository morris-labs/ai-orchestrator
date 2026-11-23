// The escalations that wait in the Builds area. Each build's Project manager
// inbox lists the items whose pointer didn't reach the box's session and the
// escalations without an answer. The app shows a build's open escalations,
// and notifies the owner once about each escalation that didn't reach the
// session after a grace period, since the server types pointers on its own.
import {
  pmItemWaits,
  type DecisionOption,
  type EscalationResolveInput,
  type PmItem,
} from "@aio/contracts";

/**
 * How long an escalation waits for its pointer to reach the Project
 * manager's session before the app notifies the owner. The server sweeps
 * every build's inbox once a minute, so a session that takes input gets the
 * pointer well within this time.
 */
export const NOTIFY_AFTER_MS = 2 * 60_000;

/**
 * The escalations of an inbox that still wait, oldest first. A resolved
 * escalation doesn't wait for anyone, even while its pointer hasn't reached
 * the session.
 */
export function openEscalations(items: readonly PmItem[]): PmItem[] {
  return items.filter((i) => i.kind === "escalation" && i.answeredAt === null && pmItemWaits(i));
}

/** The actions the owner can take on an escalation from the build view. */
export const OWNER_ACTIONS = ["retry", "reorder", "clarify", "decide"] as const;
export type OwnerAction = (typeof OWNER_ACTIONS)[number];

/** What the owner filled in on an escalation's resolve form. */
export interface ResolveForm {
  action: OwnerAction;
  note: string;
  /** With `reorder`: task IDs separated by commas or spaces. */
  order: string;
  /** With `decide`: the answer to the review run's decision. */
  decision: DecisionOption;
  /** With `decide` and `resume_waive`: finding IDs separated by commas or spaces. */
  waive: string;
  /** For a release ready escalation: the push answer, or `""` for none. */
  push: "" | "yes" | "no";
}

function idsOf(text: string): string[] {
  return text.split(/[\s,]+/).filter((id) => id !== "");
}

/**
 * The owner's resolve request for escalation `escalation` from `form`, or
 * `null` when the form lacks what its action needs: a note for `clarify`,
 * and a task order for `reorder`.
 */
export function ownerResolution(
  escalation: string,
  form: ResolveForm,
): EscalationResolveInput | null {
  const note = form.note.trim();
  const request: EscalationResolveInput = { escalation, action: form.action, by: "owner" };
  if (note) request.note = note;
  if (form.push) request.push = form.push === "yes";
  if (form.action === "clarify" && !note) return null;
  if (form.action === "reorder") {
    const order = idsOf(form.order);
    if (order.length === 0) return null;
    request.order = order;
  }
  if (form.action === "decide") {
    const waive = form.decision === "resume_waive" ? idsOf(form.waive) : [];
    request.decision = {
      option: form.decision,
      ...(waive.length > 0 ? { waiveFindingIds: waive } : {}),
      ...(note ? { reason: note } : {}),
    };
  }
  return request;
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
