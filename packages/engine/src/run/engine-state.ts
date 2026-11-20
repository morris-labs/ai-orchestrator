// The engine's own bookkeeping for a run, kept beside `state.json` in
// `engine.json`. `RunState` is the contract that the server and apps read;
// this file holds what only the state machine needs to resume.
import { ProfileSchema, RoleAssignmentSchema, RoleSchema, VendorSchema } from "@aio/contracts";
import { ReviewRangeSchema } from "../range/review-range.js";
import { z } from "zod";

const VendorStatsSchema = z.object({
  tokensIn: z.number().nonnegative().default(0),
  tokensOut: z.number().nonnegative().default(0),
  premiumRequests: z.number().nonnegative().default(0),
  aiCredits: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().default(0),
});
export type VendorUsageTotals = z.infer<typeof VendorStatsSchema>;

export const EngineStateSchema = z.object({
  version: z.literal(1).default(1),
  /** Which loop drives the run: the pre-push rounds, or the post-push loop after a push. */
  phase: z.enum(["pre-push", "post-push"]).default("pre-push"),
  /** Post-push: the pull request title and draft flag from the push request. */
  push: z.object({ title: z.string().nullable(), draft: z.boolean() }).nullable().default(null),
  /** Counters for ids that must stay unique across a resume. */
  counters: z
    .object({
      finding: z.number().int().nonnegative().default(0),
      agent: z.number().int().nonnegative().default(0),
      lease: z.number().int().nonnegative().default(0),
    })
    .default({}),
  /** The branch the fixer commits to, or `null` for a read-only SHA tip. */
  tipRef: z.string().nullable().default(null),
  /**
   * Whether round 1 reviews the working tree, as range resolution decided:
   * never for a SHA tip, a tip that isn't checked out, or a clean tree.
   * `null` in runs created before the engine recorded it.
   */
  includeWorktree: z.boolean().nullable().default(null),
  /** The commit the diff starts from: the merge base, or the pinned base. */
  diffBaseSha: z.string().nullable().default(null),
  /** Consecutive rounds that confirmed no finding above `nit`. */
  cleanRounds: z.number().int().nonnegative().default(0),
  /** Consecutive rounds whose overlap rate exceeded the threshold. */
  highOverlapRounds: z.number().int().nonnegative().default(0),
  /** True once high overlap switched the reviewers to alternate across rounds. */
  alternating: z.boolean().default(false),
  /** Fix and gate attempts in the current round. */
  gateAttempts: z.number().int().nonnegative().default(0),
  /**
   * Goes up each time a person answers a `gate_failed` decision. The fix and
   * gate files of a round carry it, so a resumed run runs the fix and the
   * gate again instead of replaying the attempts that led to the decision.
   */
  fixEpoch: z.number().int().nonnegative().default(0),
  /** Changes a person asked for, applied at the start of the next round. */
  pendingProfile: ProfileSchema.nullable().default(null),
  pendingAssign: z
    .array(z.object({ role: RoleSchema, vendors: z.array(VendorSchema).min(1) }))
    .default([]),
  /**
   * Vendors that reported a usage or rate limit in this run, so no call goes
   * to them until `until`. `null` means the vendor gave no reset time, and
   * the block lasts until a person acts. Absent in older runs.
   */
  limitedVendors: z
    .record(VendorSchema, z.object({ until: z.string().nullable(), message: z.string() }))
    .default({}),
  /** Roles a person assigned by hand; they hold until a profile switch. */
  manualRoles: RoleAssignmentSchema.partial().default({}),
  /** Re-resolve the base before the next round. */
  pendingRebase: z.boolean().default(false),
  /** Findings a person chose to resume past in an oscillation decision. */
  acceptedOscillations: z.array(z.string()).default([]),
  roundStartedAt: z.string().nullable().default(null),
  /** True from the start of a round's find stage until the round ends. */
  roundOpen: z.boolean().default(false),
  /** HEAD before the round's first fix, for the confirmer's diff. */
  preFixSha: z.string().nullable().default(null),
  /** Vendors the engine called as the fixer this round; the confirmer must be another. */
  roundFixers: z.array(VendorSchema).default([]),
  /**
   * At the `standard` depth, the commit the current round's review diff starts
   * from: where the last round's fixes began. `null` reviews the whole range.
   */
  reviewFrom: z.string().nullable().default(null),
  /** At the `standard` depth, the commit the current round reviewed up to. */
  reviewedHead: z.string().nullable().default(null),
  /** The gate's last failure report, for the next fix attempt. */
  lastGateFailure: z.string().nullable().default(null),
  /** The round's shared commits, snapshot, and groups, keyed by round and tip. */
  reviewRange: ReviewRangeSchema.nullable().default(null),
  /** Merges whose findings are saved, by commit file; a resumed stage never applies one twice. */
  appliedMerges: z.array(z.string()).default([]),
  /** Findings the fixer declined to fix; not sent to it again. */
  declined: z.array(z.string()).default([]),
  /** Below-floor findings a triage call already covered; none is asked about twice. */
  triaged: z.array(z.string()).default([]),
  /** Usage of the current round per vendor. */
  roundUsage: z.record(VendorSchema, VendorStatsSchema).default({}),
  /** Post-push: external references already imported as findings. */
  importedRefs: z.array(z.string()).default([]),
  /** Post-push: review threads the loop already replied to. */
  answeredThreads: z.array(z.string()).default([]),
  /** Post-push: review threads the loop already resolved. */
  resolvedThreads: z.array(z.string()).default([]),
  /** Post-push: the round the post-push loop started after; its rounds count from there. */
  postPushStartRound: z.number().int().nonnegative().nullable().default(null),
  /** Post-push: the commit the loop last pushed. */
  pushedHead: z.string().nullable().default(null),
  /** Post-push: the head SHA whose Copilot review the loop last requested. */
  reviewRequestedFor: z.string().nullable().default(null),
  /**
   * Post-push: the head SHA whose Copilot review request GitHub didn't
   * take. The poll doesn't wait for a review of it.
   */
  reviewDroppedFor: z.string().nullable().default(null),
});
export type EngineState = z.infer<typeof EngineStateSchema>;

export function newEngineState(): EngineState {
  return EngineStateSchema.parse({});
}
