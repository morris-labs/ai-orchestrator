// The size rule of session resume (the design's "Session resume"): a
// resumed session rereads its whole history, at full price once the
// vendor's prompt cache expired, so a large, cold session gets a fresh
// agent. A placement change gets one too, because a different model or
// effort can't use the session's cache.
import type {
  BuildSessionSettings,
  SeatPlacement,
  SessionReason,
  SessionRecord,
} from "@aio/contracts";

/** True when two placements run on the same vendor, tier, and effort. */
export function samePlacement(a: SeatPlacement, b: SeatPlacement): boolean {
  return a.vendor === b.vendor && a.tier === b.tier && a.effort === b.effort;
}

/**
 * Why a message for `session` must go to a fresh agent instead of resuming
 * it, at `now` (epoch milliseconds) with the seat's `placement` for its next
 * agent; `null` when the session can be resumed.
 */
export function freshReason(
  session: SessionRecord,
  placement: SeatPlacement,
  now: number,
  settings: BuildSessionSettings,
): Exclude<SessionReason, "step"> | null {
  if (placement.fresh || !samePlacement(session.placement, placement)) return "placement";
  if (session.sessionId === null) return "no_session";
  const last = session.turns.at(-1);
  if (!last) return "no_session";
  const window = settings.cacheWindowMinutes[session.vendor] * 60_000;
  const cold = now - Date.parse(last.at) > window;
  return cold && last.inputTokens > settings.freshAboveTokens ? "size" : null;
}
