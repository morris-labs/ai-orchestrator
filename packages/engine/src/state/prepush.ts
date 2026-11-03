// The pre-push state machine (design.md, "Pre-push pipeline"). Each stage
// reads the files the previous stage wrote, so the driver can start at any
// stage after a crash, a pause, or a decision.
import type { Finding, Role, RoleAssignment, StopReason, Vendor } from "@aio/contracts";
import { runGate } from "../gate/gate.js";
import { resolveRange } from "../range/resolve.js";
import { DecisionNeeded, type RunContext } from "./context.js";
import { assignRoles } from "./profiles.js";
import {
  GATE_ATTEMPTS,
  aboveNit,
  buildRoundSummary,
  computeGroups,
  confirmedThisRound,
  disposeBaseWorktree,
  disposeCheckouts,
  fixTargets,
  oscillationDecision,
  runConfirm,
  runFind,
  runFix,
  runGateStage,
  runMerge,
  runSweep,
  verifyPending,
  warnLeftovers,
  type MergeOutput,
} from "./steps.js";

/** Runs the preflight: the baseline of the policy's tests and lint. */
export async function stagePreflight(ctx: RunContext): Promise<void> {
  let preflight = await ctx.store.readJson<{ baseline: unknown }>("preflight.json");
  if (!preflight) {
    const baseline = await runGate(ctx.policy, {
      repoPath: ctx.state.request.repoPath,
      shell: ctx.shell,
      git: ctx.deps.runner,
      signal: ctx.signal,
    });
    warnLeftovers(ctx, baseline);
    preflight = {
      range: {
        baseRef: ctx.state.request.base,
        baseSha: ctx.state.baseSha,
        tipRef: ctx.eng.tipRef,
        tipSha: ctx.state.tipSha,
        diffBaseSha: ctx.eng.diffBaseSha,
      },
      baseline,
    } as { baseline: unknown };
    await ctx.store.writeJson("preflight.json", preflight);
    await ctx.handoff(
      { stage: "preflight" },
      { stage: "group" },
      "baseline",
      baseline.commands.length,
      "preflight.json",
    );
  }
}

function rolesDiffer(a: RoleAssignment, b: RoleAssignment, role: Role): boolean {
  const x = role === "reviewer" ? a.reviewer : [a[role]];
  const y = role === "reviewer" ? b.reviewer : [b[role]];
  return x.join(",") !== y.join(",");
}

async function emitRoleChanges(
  ctx: RunContext,
  before: RoleAssignment,
  after: RoleAssignment,
  reason: "manual" | "overlap" | "profile",
  effectiveRound: number,
): Promise<void> {
  for (const role of ["reviewer", "disprover", "confirmer", "fixer"] as const) {
    if (!rolesDiffer(before, after, role)) continue;
    await ctx.emit({
      type: "role.reassigned",
      runId: ctx.state.id,
      role,
      from: role === "reviewer" ? before.reviewer : [before[role]],
      to: role === "reviewer" ? after.reviewer : [after[role]],
      reason,
      effectiveRound,
    });
  }
}

/** Re-resolves the base from the request's base ref and keeps the tip. */
export async function rebaseBase(ctx: RunContext): Promise<void> {
  const range = await resolveRange(
    ctx.deps.runner,
    {
      repoPath: ctx.state.request.repoPath,
      base: ctx.state.request.base,
      tip: ctx.eng.tipRef ?? ctx.state.tipSha,
      mergeBase: ctx.state.request.mergeBase,
      exactBase: ctx.state.request.exactBase,
      readOnly: ctx.state.request.readOnly,
      // The tree may have changed since the run started; a new base doesn't
      // make a clean-tree run start reviewing uncommitted changes.
      includeWorktree: true,
      prNumber: ctx.state.prNumber ?? ctx.state.request.prNumber,
    },
    ctx.deps.github,
  );
  ctx.state.baseSha = range.baseSha;
  ctx.state.tipSha = range.tipSha;
  ctx.eng.diffBaseSha = range.diffBaseSha;
  ctx.eng.includeWorktree =
    (ctx.eng.includeWorktree ?? ctx.state.request.includeWorktree) && range.includeWorktree;
  await disposeBaseWorktree(ctx);
}

/** Opens a new round: applies pending changes, assigns roles, and groups the diff. */
export async function startRound(ctx: RunContext): Promise<void> {
  if (ctx.eng.roundOpen) return;
  // The round reviews HEAD of the checkout, which a person or the box's own
  // session can move to another branch between rounds.
  const tipRef = ctx.eng.tipRef;
  if (tipRef && !ctx.state.request.readOnly) {
    const current = await ctx.git.currentBranch();
    if (current !== tipRef) {
      throw new DecisionNeeded({
        kind: "push_blocked",
        findingIds: [],
        options: ["resume", "cancel"],
        message: `The run fixes ${tipRef}, but ${current ?? "a detached HEAD"} is checked out in ${ctx.state.request.repoPath}. Check out ${tipRef} and resume, or cancel.`,
      });
    }
  }
  ctx.state.round += 1;
  const round = ctx.state.round;
  ctx.eng.roundStartedAt = ctx.nowIso();
  ctx.eng.roundUsage = {};
  ctx.eng.gateAttempts = 0;
  ctx.eng.preFixSha = null;
  ctx.eng.roundFixers = [];
  ctx.eng.lastGateFailure = null;

  if (ctx.eng.pendingRebase) {
    await rebaseBase(ctx);
    ctx.eng.pendingRebase = false;
  }
  let reason: "manual" | "profile" = "profile";
  if (ctx.eng.pendingProfile) {
    ctx.state.profile = ctx.eng.pendingProfile;
    ctx.eng.pendingProfile = null;
    ctx.eng.manualRoles = {};
  }
  if (ctx.eng.pendingAssign.length > 0) {
    for (const a of ctx.eng.pendingAssign) {
      if (a.role === "reviewer") ctx.eng.manualRoles.reviewer = a.vendors;
      else ctx.eng.manualRoles[a.role] = a.vendors[0] as Vendor;
    }
    ctx.eng.pendingAssign = [];
    reason = "manual";
  }
  const before = ctx.state.roles;
  const after = assignRoles({
    profile: ctx.state.profile,
    round,
    available: ctx.availableVendors,
    manual: ctx.eng.manualRoles,
    alternating: ctx.eng.alternating,
    crossVendor: ctx.state.request.crossVendor,
  });
  ctx.state.roles = after;
  if (round > 1) await emitRoleChanges(ctx, before, after, reason, round);

  ctx.state.tipSha = ctx.state.request.readOnly ? ctx.state.tipSha : await ctx.git.head();
  const reuse = round === 1 ? await ctx.store.loadGroups() : undefined;
  const groups = reuse ?? (await computeGroups(ctx));
  await ctx.store.saveGroups(groups, round);
  ctx.eng.roundOpen = true;
  await ctx.persist();
  await ctx.emitRun();
}

/** Closes the round: writes the summary and decides whether to stop. Returns the stop reason, if any. */
export async function endRound(ctx: RunContext): Promise<StopReason | null> {
  const merge = await ctx.store.readJson<MergeOutput>(ctx.store.roundFile(ctx.round, "merge"));
  const sweep = await ctx.store.readJson<MergeOutput | null>(
    ctx.store.roundFile(ctx.round, "sweep"),
  );
  const raised: Partial<Record<Vendor, number>> = { ...(merge?.raisedByVendor ?? {}) };
  for (const [v, n] of Object.entries(sweep?.raisedByVendor ?? {})) {
    raised[v as Vendor] = (raised[v as Vendor] ?? 0) + (n ?? 0);
  }
  const overlapRate = merge?.overlapRate ?? 0;
  const summary = buildRoundSummary(ctx, raised, overlapRate);
  await ctx.store.saveRoundSummary(summary);

  const confirmed = confirmedThisRound(ctx);
  ctx.eng.cleanRounds = confirmed.length === 0 ? ctx.eng.cleanRounds + 1 : 0;

  const reviewersSideBySide = ctx.state.roles.reviewer.length > 1;
  ctx.eng.highOverlapRounds =
    reviewersSideBySide && overlapRate > ctx.state.request.overlapThreshold
      ? ctx.eng.highOverlapRounds + 1
      : 0;
  if (ctx.eng.highOverlapRounds >= 2 && !ctx.eng.alternating) {
    ctx.eng.alternating = true;
    const next = assignRoles({
      profile: ctx.state.profile,
      round: ctx.round + 1,
      available: ctx.availableVendors,
      manual: ctx.eng.manualRoles,
      alternating: true,
      crossVendor: ctx.state.request.crossVendor,
    });
    await ctx.emit({
      type: "role.reassigned",
      runId: ctx.state.id,
      role: "reviewer",
      from: ctx.state.roles.reviewer,
      to: next.reviewer,
      reason: "overlap",
      effectiveRound: ctx.round + 1,
    });
  }

  ctx.eng.roundOpen = false;
  await ctx.persist();
  await ctx.emitRun(summary);

  if (ctx.eng.cleanRounds >= 2 && openFindings(ctx).length === 0) return "clean";
  if (ctx.round >= ctx.state.request.roundCap) return "round_cap";
  return null;
}

/**
 * Findings that keep a run from stopping clean: any finding still waiting
 * for its disprover, and, in a run that fixes, any confirmed finding above
 * `nit` that the fixer still has to work on, such as one whose fix the
 * confirmer found incomplete. A finding the fixer declined is
 * left to a person.
 */
export function openFindings(ctx: RunContext): Finding[] {
  const declined = new Set(ctx.eng.declined);
  const fixes = !ctx.state.request.readOnly;
  return ctx.findings.filter(
    (f) =>
      f.verdict === "pending" ||
      (fixes && f.verdict === "confirmed" && aboveNit(f) && !declined.has(f.id)),
  );
}

/** Finishes the run with a stop reason. */
export async function finish(ctx: RunContext, reason: StopReason): Promise<void> {
  await disposeCheckouts(ctx);
  await ctx.setStage("done");
  await ctx.setStatus("finished", { stopReason: reason, decision: null });
}

/**
 * Closes the round and finishes the run when a stop condition holds. A
 * pending decision, such as an oscillation, wins over the stop: the run
 * moves to the next round's find stage and waits for a person, who can
 * still cancel.
 */
async function closeRound(ctx: RunContext, decision?: DecisionNeeded): Promise<boolean> {
  const stop = await endRound(ctx);
  if (stop && !decision) {
    await finish(ctx, stop);
    return true;
  }
  await ctx.setStage("find");
  if (decision) throw decision;
  return false;
}

function openOscillations(ctx: RunContext, merge: MergeOutput | null): DecisionNeeded | undefined {
  const open = (merge?.oscillations ?? []).filter(
    (o) => !ctx.eng.acceptedOscillations.includes(o.fixedId),
  );
  return open.length > 0 ? oscillationDecision(ctx, open) : undefined;
}

/** Drives the pre-push stages until the run finishes, waits, or fails. */
export async function drivePrePush(ctx: RunContext): Promise<void> {
  for (;;) {
    await ctx.checkpoint();
    switch (ctx.state.stage) {
      case "preflight":
        await stagePreflight(ctx);
        if (ctx.eng.phase === "post-push") return;
        await ctx.setStage("group");
        break;
      case "group": {
        const groups = await computeGroups(ctx);
        await ctx.store.saveGroups(groups);
        const hunks = groups.reduce((n, g) => n + g.hunks.length, 0);
        await ctx.handoff({ stage: "group" }, { stage: "find" }, "hunks", hunks, "groups.json");
        await ctx.setStage("find");
        break;
      }
      case "find": {
        await startRound(ctx);
        const groups = (await ctx.store.loadGroups(ctx.round)) ?? [];
        // A range with nothing to review, such as a tip equal to its base,
        // finishes at once instead of spending reviewer calls on an empty diff.
        if (groups.length === 0 && ctx.round === 1 && ctx.findings.length === 0) {
          ctx.state.notices = [
            ...(ctx.state.notices ?? []),
            "The range has no changes to review, so the run reviewed nothing.",
          ];
          await endRound(ctx);
          await finish(ctx, "clean");
          return;
        }
        await runFind(ctx, groups);
        await ctx.setStage("merge");
        break;
      }
      case "merge": {
        const groups = (await ctx.store.loadGroups(ctx.round)) ?? [];
        const find = await runFind(ctx, groups);
        const merge = await runMerge(ctx, find, groups);
        await ctx.setStage("verify");
        const open = merge.oscillations.filter(
          (o) => !ctx.eng.acceptedOscillations.includes(o.fixedId),
        );
        if (open.length > 0) throw oscillationDecision(ctx, open);
        break;
      }
      case "verify":
        await verifyPending(ctx, ctx.store.roundFile(ctx.round, "verify"));
        await ctx.setStage("sweep");
        break;
      case "sweep": {
        const groups = (await ctx.store.loadGroups(ctx.round)) ?? [];
        const sweep = await runSweep(ctx, groups);
        if (sweep && sweep.created.length > 0) {
          await verifyPending(ctx, ctx.store.roundFile(ctx.round, "sweep-verify"));
        }
        const decision = openOscillations(ctx, sweep);
        if (ctx.state.request.readOnly || fixTargets(ctx).length === 0) {
          if (await closeRound(ctx, decision)) return;
        } else {
          await ctx.setStage("fix");
          if (decision) throw decision;
        }
        break;
      }
      case "fix": {
        const targets = fixTargets(ctx);
        if (targets.length === 0 && ctx.eng.gateAttempts === 0) {
          if (await closeRound(ctx)) return;
          break;
        }
        await runFix(ctx, targets, ctx.eng.lastGateFailure ?? undefined);
        await ctx.setStage("gate");
        break;
      }
      case "gate": {
        const record = await runGateStage(ctx, "confirm");
        if (record.regressed) {
          ctx.eng.gateAttempts += 1;
          ctx.eng.lastGateFailure = record.report;
          await ctx.persist();
          if (ctx.eng.gateAttempts >= GATE_ATTEMPTS) {
            throw new DecisionNeeded({
              kind: "gate_failed",
              findingIds: ctx.findings
                .filter((f) => f.verdict === "confirmed" && f.fixCommit)
                .map((f) => f.id),
              options: ["resume", "cancel"],
              message: `The fixes still break the test or lint gate after ${GATE_ATTEMPTS} attempts:\n${record.report}`,
            });
          }
          await ctx.setStage("fix");
        } else {
          ctx.eng.lastGateFailure = null;
          await ctx.persist();
          await ctx.setStage("confirm");
        }
        break;
      }
      case "confirm": {
        const groups = (await ctx.store.loadGroups(ctx.round)) ?? [];
        try {
          await runConfirm(ctx, groups);
        } catch (error) {
          // The confirm output is saved; close the round before asking.
          if (error instanceof DecisionNeeded) await closeRound(ctx, error);
          throw error;
        }
        if (await closeRound(ctx)) return;
        break;
      }
      case "done":
        return;
      default:
        // Post-push stages belong to the post-push driver.
        return;
    }
  }
}
