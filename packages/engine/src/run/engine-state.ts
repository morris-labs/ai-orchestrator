// The engine's own bookkeeping for a run, kept beside `state.json` in
// `engine.json`. `RunState` is the contract that the server and apps read;
// this file holds what only the state machine needs to resume.
import { ProfileSchema, RoleAssignmentSchema, RoleSchema, VendorSchema } from "@agentbox/contracts";
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
  /** Changes a person asked for, applied at the start of the next round. */
  pendingProfile: ProfileSchema.nullable().default(null),
  pendingAssign: z
    .array(z.object({ role: RoleSchema, vendors: z.array(VendorSchema).min(1) }))
    .default([]),
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
  /** The gate's last failure report, for the next fix attempt. */
  lastGateFailure: z.string().nullable().default(null),
  /** Findings the fixer declined as not real defects; not sent to it again. */
  declined: z.array(z.string()).default([]),
  /** Usage of the current round per vendor. */
  roundUsage: z.record(VendorSchema, VendorStatsSchema).default({}),
  /** Post-push: external references already imported as findings. */
  importedRefs: z.array(z.string()).default([]),
  /** Post-push: review threads the loop already replied to and resolved. */
  answeredThreads: z.array(z.string()).default([]),
  /** Post-push: the head SHA whose Copilot review the loop last requested. */
  reviewRequestedFor: z.string().nullable().default(null),
});
export type EngineState = z.infer<typeof EngineStateSchema>;

export function newEngineState(): EngineState {
  return EngineStateSchema.parse({});
}
