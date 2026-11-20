import type { RunState } from "@aio/contracts";
import { z } from "zod";
import { reviewRangeSeed } from "../range/review-range.js";
import type { EngineState } from "./engine-state.js";

/** Restores a saved round from the fields written before the review-range format. */
export function adaptEngineReviewRange(
  state: RunState,
  engine: EngineState,
  legacy: unknown,
): EngineState {
  if (engine.reviewRange || !state.tipSha || !state.baseSha) return engine;
  const includeWorktree = engine.includeWorktree ?? state.request.includeWorktree;
  const range = reviewRangeSeed({
    request: state.request,
    round: state.round,
    reviewedFrom: engine.reviewFrom,
    preFixSha: engine.preFixSha,
    resolved: {
      baseRef: state.request.base,
      baseSha: state.baseSha,
      diffBaseSha: engine.diffBaseSha ?? state.baseSha,
      tipRef: engine.tipRef,
      tipSha: state.tipSha,
      dirty: includeWorktree,
      includeWorktree,
    },
  });
  const snapshot = z
    .object({ key: z.string(), commit: z.string(), head: z.string() })
    .safeParse(legacy);
  if (
    range.worktree &&
    snapshot.success &&
    snapshot.data.key === `${state.round}:${state.tipSha}:true`
  ) {
    range.tipCommit = snapshot.data.commit;
    range.promptRange.tipSha = snapshot.data.commit;
    range.tipCheckout = { commit: snapshot.data.commit, head: snapshot.data.head };
    range.linesAt = `worktree:${state.tipSha}:${snapshot.data.commit}`;
  }
  return { ...engine, reviewRange: range };
}
