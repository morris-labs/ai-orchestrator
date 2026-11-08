// The stage bodies that the pre-push and post-push drivers share. Each step
// reads its inputs from the run context, writes its output file to the run
// directory, and emits handoff events with counts.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  STANDARD_GROUP_SIZE_LIMIT,
  VENDOR_ROLES,
  belowVerifyFloor,
  runDepth,
  taskLabel,
} from "@aio/contracts";
import type {
  AgentRole,
  RootCause,
  FileGroup,
  Finding,
  FindingOrigin,
  Hunk,
  RoundSummary,
  Stage,
  Vendor,
  VendorFinding,
  VendorRoundStats,
} from "@aio/contracts";
import type {
  ClusterOutput,
  ConfirmOutput,
  FixOutput,
  ReviewOutput,
  SweepOutput,
  VerifyBatchOutput,
  VerifyOutput,
} from "../core.js";
import { compareGate, formatRegressions, runGate, type GateRun } from "../gate/gate.js";
import { hasExclusions, selectFiles } from "../group/exclude.js";
import { groupFiles } from "../group/group.js";
import { assignTiers } from "../group/signals.js";
import { roleTier, tierRank, type TierChoice } from "../group/tier.js";
import {
  hunksForFinding,
  missingHunks,
  newLedger,
  recordVerdicts,
  type GroupLedger,
} from "../ledger/ledger.js";
import { enclosingSymbol, fingerprint } from "../merge/fingerprint.js";
import { findingsLog, mergeCandidates, type Candidate, type MergeResult } from "../merge/merge.js";
import { isRiskPath, policyPromptSection } from "../policy/rules.js";
import {
  batchDisproverPrompt,
  clusterPrompt,
  isExternal,
  triageLine,
  triagePrompt,
  batchFindingBlock,
  confirmerPrompt,
  continuationPrompt,
  finderPrompt,
  fixerPrompt,
  ledgerFollowUpPrompt,
  sweepPrompt,
} from "../prompts/templates.js";
import { parseDiff } from "../range/diff.js";
import {
  batchEffort,
  planVerifyBatches,
  relatedFindings,
  rootCauseDuplicates,
  splitByTokens,
  type VerifyBatch,
} from "../verify/batch.js";
import {
  BaseWorktree,
  FALLBACK_ORDER,
  baseWorktreePath,
  chooseDisprover,
  judgeAnswer,
  verifyFinding,
  type VerifyResult,
} from "../verify/verify.js";
import {
  EngineCheckout,
  removeCheckout,
  scriptCheckoutsDir,
  type CheckoutState,
} from "./checkout.js";
import {
  AgentFailed,
  RoleDenied,
  DecisionNeeded,
  RunCancelled,
  SafetyRefused,
  type AgentCallSpec,
  type AgentOutcome,
  type CallTier,
  type RunContext,
} from "./context.js";
import { snapshotTree } from "./tree-guard.js";
import { planReviews, type ReviewTask } from "./profiles.js";

/** Ledger follow-ups per reviewer before the engine accepts missing verdicts. */
export const LEDGER_FOLLOW_UPS = 2;
/** Fix attempts in one round before a gate regression needs a person. */
export const GATE_ATTEMPTS = 3;
/** Parallel disprover calls. */
const VERIFY_CONCURRENCY = 4;
/** The most a batched disprover call's time limit grows over one finding's. */
const BATCH_TIMEOUT_FACTOR = 4;
/**
 * Parallel reviewer tasks per vendor in the find stage. Each task is one
 * CLI agent; without a limit a large range starts one per group at once,
 * which spends a usage window before a ceiling or a cancel can react.
 */
/** The largest diff, in estimated tokens, that a sweep prompt carries inline. */
export const SWEEP_DIFF_TOKEN_LIMIT = 150_000;
export const FIND_CONCURRENCY_PER_VENDOR = 6;

const SEVERITY_ABOVE_NIT = new Set(["P1", "P2", "P3"]);

export function aboveNit(f: Pick<Finding, "severity">): boolean {
  return SEVERITY_ABOVE_NIT.has(f.severity);
}

/**
 * Runs `fn` over items with at most `limit` in flight per vendor, every
 * vendor at once, and returns the results in the items' order.
 */
export async function runPerVendor<T extends { vendor: Vendor }, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const byVendor = new Map<Vendor, number[]>();
  items.forEach((item, index) => {
    const list = byVendor.get(item.vendor) ?? [];
    list.push(index);
    byVendor.set(item.vendor, list);
  });
  const results: R[] = new Array<R>(items.length);
  await Promise.all(
    [...byVendor.values()].map((indexes) =>
      mapLimit(indexes, limit, async (index) => {
        results[index] = await fn(items[index] as T);
      }),
    ),
  );
  return results;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  // After one item fails, the other workers take no new items: the stage is
  // over, and work started now would outlive it.
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failed) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Rough token estimate for a prompt: four characters per token. */
export function estimateTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}

// ---------------------------------------------------------------------------
// Diff and groups

/** True when the round reviews the working tree: round 1, when range resolution allowed it. */
export function reviewsWorktree(ctx: RunContext): boolean {
  const resolved = ctx.eng.includeWorktree ?? ctx.state.request.includeWorktree;
  return resolved && ctx.round <= 1;
}

/**
 * The commit the diff ends at and files are read from: the tip SHA, or,
 * when the round reviews the working tree, the snapshot commit of it. The
 * snapshot holds the untracked files git doesn't ignore, which a diff to
 * the working tree leaves out.
 */
async function diffTip(ctx: RunContext): Promise<string> {
  if (reviewsWorktree(ctx)) return (await readOnlyState(ctx)).commit;
  return ctx.state.tipSha ?? "HEAD";
}

/**
 * The code version that this stage's finding lines count in, for the
 * merge's `linesAt`: the tip SHA, prefixed with `worktree:` when the round
 * reviews uncommitted changes. Empty when the tip isn't known yet.
 */
export function linesVersion(ctx: RunContext): { linesAt?: string } {
  const tip = ctx.state.tipSha;
  if (!tip) return {};
  return { linesAt: reviewsWorktree(ctx) ? `worktree:${tip}` : tip };
}

/** The live state for one stage's read-only checkout, by run context. */
const readOnlyStates = new WeakMap<RunContext, { key: string; state: Promise<CheckoutState> }>();

/**
 * What a read-only call of the current round looks at: the tip commit, or,
 * when the round reviews the working tree, a snapshot commit of it with
 * `HEAD` at the tip, so the uncommitted changes show as uncommitted. The
 * snapshot is taken once per round and tip, so every stage and every
 * parallel call sees the same files, and the read-only checkout isn't
 * rebuilt for each stage. A fix that commits moves the tip, which takes a
 * new snapshot.
 */
function readOnlyState(ctx: RunContext): Promise<CheckoutState> {
  const worktree = reviewsWorktree(ctx);
  const key = `${ctx.round}:${ctx.state.tipSha ?? ""}:${worktree}`;
  const cached = readOnlyStates.get(ctx);
  if (cached?.key === key) return cached.state;
  const state = (async (): Promise<CheckoutState> => {
    if (!worktree) {
      const tip = ctx.state.tipSha ?? (await ctx.git.head());
      return { commit: tip, head: tip };
    }
    const head = await ctx.git.head();
    const index = join(tmpdir(), `aio-index-${ctx.state.id}-${Date.now()}`);
    return { commit: await ctx.git.snapshotWorktree(index), head };
  })();
  readOnlyStates.set(ctx, { key, state });
  state.catch(() => {
    if (readOnlyStates.get(ctx)?.state === state) readOnlyStates.delete(ctx);
  });
  return state;
}

/**
 * The engine-owned checkout that the current stage's read-only calls run
 * in, created or moved to the stage's state (see `checkout.ts`). Read-only
 * calls never run in the checkout under review, so a person, the box's
 * session, or another run can keep working there, and restoring the
 * checkout after a call changed it can't touch their files.
 */
export async function readOnlyRepo(ctx: RunContext): Promise<string> {
  if (ctx.cancelled) throw new RunCancelled();
  return ctx.readOnlyCheckout.ensure(await readOnlyState(ctx));
}

/**
 * The commit the round's review diff starts from. At the `standard` depth,
 * round 2 and later review what changed after the last review, not the branch.
 */
function reviewDiffBase(ctx: RunContext): string {
  if (reviewsFixDiffOnly(ctx)) return ctx.eng.reviewFrom as string;
  return ctx.eng.diffBaseSha ?? ctx.state.baseSha ?? "";
}

/** True when the round reviews only the change since the last review. */
function reviewsFixDiffOnly(ctx: RunContext): boolean {
  // A whole-project run never reviews the project twice, at any depth.
  const narrows = runDepth(ctx.state.request) === "standard" || isWholeProject(ctx);
  return narrows && ctx.round > 1 && !!ctx.eng.reviewFrom;
}

function isWholeProject(ctx: RunContext): boolean {
  return ctx.state.request.scope === "whole";
}

/** True when the round's diff is the whole project, not a fixer's diff. */
function reviewsWholeProject(ctx: RunContext): boolean {
  return isWholeProject(ctx) && !reviewsFixDiffOnly(ctx);
}

/**
 * Recreates the empty base of a whole-project run, which no ref keeps. The
 * commit has a fixed SHA, so after a garbage collection the run goes on as if
 * nothing happened, and writing it again restarts the object's prune clock.
 */
export async function ensureWholeBase(ctx: RunContext): Promise<void> {
  if (isWholeProject(ctx)) await ctx.git.emptyBaseCommit();
}

/** The range of a round that reviews only the fixer's diff. */
function fixDiffRange(ctx: RunContext, repoPath: string, diffBase: string) {
  const { wholeProject: _wholeProject, ...range } = ctx.range(repoPath);
  return { ...range, baseSha: diffBase };
}

/** Computes the file groups for the current tip. */
export async function computeGroups(ctx: RunContext): Promise<FileGroup[]> {
  const diffBase = reviewDiffBase(ctx);
  const tip = await diffTip(ctx);
  const depth = runDepth(ctx.state.request);
  const standard = depth === "standard";
  const wholeDiff = reviewsWholeProject(ctx);
  await ensureWholeBase(ctx);
  const { files, excluded } = selectFiles(
    wholeDiff
      ? await ctx.git.addedFiles(diffBase, tip)
      : parseDiff(await ctx.git.diff(diffBase, tip)),
    ctx.state.request,
    ctx.policy,
  );
  if (excluded.length > 0) {
    ctx.deps.log?.info?.("Left files out of the review", {
      runId: ctx.state.id,
      round: ctx.round,
      count: excluded.length,
    });
  }
  const groups = await groupFiles(files, {
    policy: ctx.policy,
    readFile: (path) => ctx.git.show(tip, path),
    ...(standard
      ? { coarse: true, sizeLimit: ctx.extras.groupSizeLimit ?? STANDARD_GROUP_SIZE_LIMIT }
      : {}),
  });
  const choice = ctx.state.request.modelTier;
  if (!choice) return groups;
  const tiered = await assignTiers(groups, files, {
    git: ctx.git,
    policy: ctx.policy,
    diffBase,
    tip,
    choice,
    depth,
    skipHistory: wholeDiff,
    now: () => ctx.clock.now(),
  });
  for (const g of tiered) {
    ctx.deps.log?.info?.("Chose a group's model tier", {
      runId: ctx.state.id,
      round: ctx.round,
      groupId: g.id,
      tier: g.tier,
      reason: g.tierReason,
    });
  }
  return tiered;
}

/**
 * The tier of a call that covers `files`, or all of `groups` when `files` is
 * absent. Absent when the run doesn't use tiers. Group ids change from round
 * to round, so the lookup goes by file.
 */
export function callTier(
  ctx: RunContext,
  role: AgentRole,
  groups: readonly FileGroup[],
  files?: readonly string[],
): CallTier | undefined {
  const choice = ctx.state.request.modelTier;
  if (!choice) return undefined;
  const covering = files ? groups.filter((g) => g.files.some((f) => files.includes(f))) : groups;
  let base: TierChoice | null = null;
  for (const g of covering) {
    if (g.tier && (!base || tierRank(g.tier) > tierRank(base.tier))) {
      base = { tier: g.tier, reason: g.tierReason ?? `Group ${g.id}.` };
    }
  }
  if (runDepth(ctx.state.request) === "standard") {
    // A finding from an earlier round can sit in a file this round's groups
    // leave out, and a risk path keeps its tier there too.
    if (!base && files?.some((f) => isRiskPath(ctx.policy, f))) {
      base = { tier: "large", reason: "A file of the call matches a risk path." };
    }
    return {
      ...roleTier(base, role, { choice, persisting: false, depth: "standard" }),
      fixed: choice !== "auto",
    };
  }
  const declined = new Set(ctx.eng.declined);
  const scope = new Set(files ?? groups.flatMap((g) => g.files));
  // A finding persists when a fix had its chance and it's still confirmed. A
  // nit, a read-only run, and an unverified finding give no fix that chance.
  const persisting =
    !ctx.state.request.readOnly &&
    ctx.findings.some(
      (f) =>
        f.verdict === "confirmed" &&
        aboveNit(f) &&
        !belowVerifyFloor(f, ctx.state.request.verifyFloor) &&
        f.round < ctx.round &&
        !declined.has(f.id) &&
        f.file !== null &&
        f.file !== undefined &&
        scope.has(f.file),
    );
  return { ...roleTier(base, role, { choice, persisting }), fixed: choice !== "auto" };
}

/** The current round's groups, or none when the round has no group stage. */
async function roundGroups(ctx: RunContext): Promise<FileGroup[]> {
  return (await ctx.store.loadGroups(ctx.round)) ?? [];
}

/** Reads a file at the current tip, with a per-call cache. */
function tipReader(ctx: RunContext): (path: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  let tip: Promise<string> | null = null;
  return (path) => {
    let p = cache.get(path);
    if (!p) {
      tip ??= diffTip(ctx);
      p = tip.then((rev) => ctx.git.show(rev, path));
      cache.set(path, p);
    }
    return p;
  };
}

// ---------------------------------------------------------------------------
// Find

export interface ReviewTaskResult {
  key: string;
  vendor: Vendor;
  model: string;
  groupId: string | null;
  focusAreas: readonly string[] | null;
  findings: VendorFinding[];
  ledger: GroupLedger;
  calls: number;
}

export interface FindOutput {
  round: number;
  tasks: ReviewTaskResult[];
}

function reviewerLabel(vendor: Vendor, model: string): string {
  return model === vendor || model.startsWith(`${vendor}-`) ? model : `${vendor}-${model}`;
}

function dedupeKey(f: VendorFinding): string {
  return `${f.file}:${f.lines[0]}:${f.title.toLowerCase()}`;
}

/** Runs one reviewer: the review, ledger follow-ups, and continuations until dry. */
async function runReviewTask(
  ctx: RunContext,
  task: ReviewTask,
  groups: readonly FileGroup[],
): Promise<ReviewTaskResult> {
  const group = task.groupId ? groups.find((g) => g.id === task.groupId) : undefined;
  const files = group ? group.files : [...new Set(groups.flatMap((g) => g.files))];
  const hunks: Hunk[] = group ? group.hunks : groups.flatMap((g) => g.hunks);
  const standard = runDepth(ctx.state.request) === "standard";
  const fixDiffOnly = reviewsFixDiffOnly(ctx);
  const diffBase = reviewDiffBase(ctx);
  const diff = await ctx.git.diffForPrompt(diffBase, await diffTip(ctx), files);
  const repoPath = await readOnlyRepo(ctx);
  const prompt = finderPrompt({
    range: fixDiffOnly ? fixDiffRange(ctx, repoPath, diffBase) : ctx.range(repoPath),
    round: ctx.round,
    groupId: task.groupId,
    files,
    hunks,
    diff,
    focusAreas: task.focusAreas,
    findingsLog: findingsLog(ctx.findings),
    policySection: policyPromptSection(ctx.policy, files),
    standard,
    fixDiffOnly,
  });
  const tier = callTier(ctx, "reviewer", groups, group ? group.files : undefined);
  const effort = ctx.state.request.reviewerEffort;
  const reviewerEffort = effort ? { effort } : {};
  const base = {
    role: "reviewer" as const,
    groupId: task.groupId,
    allowFallback: true,
  };
  const first = await ctx.callAgent<ReviewOutput>({
    ...base,
    ...(tier ? { tier } : {}),
    key: `find-${task.key}`,
    vendor: task.vendor,
    method: "review",
    request: { prompt, repoPath, toolPolicy: "read-only", ...reviewerEffort },
    estimateTokens: estimateTokens(prompt) + 4000,
  });
  const vendor = first.vendor;
  const label = reviewerLabel(vendor, first.model);
  const collected: VendorFinding[] = [...first.output.findings];
  const seen = new Set(collected.map(dedupeKey));
  let ledger = recordVerdicts(
    newLedger(task.groupId, hunks),
    hunks,
    label,
    first.output.ledger,
    collected,
  );
  let calls = 1;
  const sessionId = first.sessionId;
  // A session keeps a tier that a malformed answer raised, and never drops back.
  let sessionTier = tier;
  const keepTier = (out: AgentOutcome<ReviewOutput>): void => {
    if (sessionTier && out.tier && out.tier.tier !== sessionTier.tier) {
      sessionTier = { ...sessionTier, ...out.tier };
    }
  };
  keepTier(first);

  const absorb = (out: ReviewOutput): VendorFinding[] => {
    const fresh = out.findings.filter((f) => !seen.has(dedupeKey(f)));
    for (const f of fresh) {
      seen.add(dedupeKey(f));
      collected.push(f);
    }
    ledger = recordVerdicts(ledger, hunks, label, out.ledger, fresh);
    return fresh;
  };

  if (sessionId) {
    // At `standard`, a hunk with no verdict goes without one: one pass per group.
    for (let i = 0; i < (standard ? 0 : LEDGER_FOLLOW_UPS); i++) {
      const missing = missingHunks(ledger, hunks);
      if (missing.length === 0) break;
      const followUp = ledgerFollowUpPrompt(missing);
      const out = await ctx.callAgent<ReviewOutput>({
        ...base,
        ...(sessionTier ? { tier: sessionTier } : {}),
        key: `find-${task.key}-ledger${i + 1}`,
        vendor,
        method: "continueReview",
        request: {
          prompt: followUp,
          repoPath,
          toolPolicy: "read-only",
          sessionId,
          ...reviewerEffort,
        },
        estimateTokens: estimateTokens(followUp) + 2000,
        allowFallback: false,
      });
      calls += 1;
      keepTier(out);
      absorb(out.output);
    }
    for (let i = 0; i < ctx.state.request.continuationCap; i++) {
      const more = continuationPrompt({ reported: collected.map((f) => f.title), standard });
      const out = await ctx.callAgent<ReviewOutput>({
        ...base,
        ...(sessionTier ? { tier: sessionTier } : {}),
        key: `find-${task.key}-more${i + 1}`,
        vendor,
        method: "continueReview",
        request: {
          prompt: more,
          repoPath,
          toolPolicy: "read-only",
          sessionId,
          ...reviewerEffort,
        },
        estimateTokens: estimateTokens(more) + 2000,
        allowFallback: false,
      });
      calls += 1;
      keepTier(out);
      const fresh = absorb(out.output);
      if (!fresh.some((f) => f.severity === "P1" || f.severity === "P2")) break;
    }
  }
  return {
    key: task.key,
    vendor,
    model: first.model,
    groupId: task.groupId,
    focusAreas: task.focusAreas,
    findings: collected,
    ledger,
    calls,
  };
}

/** The find stage: every reviewer task of the round, in parallel. */
export async function runFind(ctx: RunContext, groups: readonly FileGroup[]): Promise<FindOutput> {
  const file = ctx.store.roundFile(ctx.round, "find");
  const saved = await ctx.store.readJson<FindOutput>(file);
  if (saved) return saved;
  const tasks = planReviews(ctx.state.roles.reviewer, groups, ctx.state.profile, {
    depth: runDepth(ctx.state.request),
    named: ctx.eng.manualRoles.reviewer,
    groupsOnly: reviewsWholeProject(ctx),
  });
  const effort = ctx.state.request.reviewerEffort;
  await ctx.planTasks(
    tasks.map((t) => ({
      key: `find-${t.key}`,
      role: "reviewer" as const,
      groupId: t.groupId,
      label: taskLabel("reviewer", `find-${t.key}`, t.groupId),
      vendor: t.vendor,
      // Copilot takes no effort setting.
      effort: t.vendor === "copilot" ? undefined : effort,
    })),
    "find",
  );
  const results = await runPerVendor(
    tasks,
    ctx.state.request.concurrency ?? FIND_CONCURRENCY_PER_VENDOR,
    (t) => runReviewTask(ctx, t, groups),
  );
  const output: FindOutput = { round: ctx.round, tasks: results };
  await ctx.store.writeJson(file, output);
  await ctx.store.writeJson(
    ctx.store.roundFile(ctx.round, "ledger"),
    results.map((r) => ({ key: r.key, vendor: r.vendor, ...r.ledger })),
  );
  const perVendor = new Map<Vendor, number>();
  for (const r of results)
    perVendor.set(r.vendor, (perVendor.get(r.vendor) ?? 0) + r.findings.length);
  for (const [vendor, count] of perVendor) {
    await ctx.handoff(
      { stage: "find", vendor, role: "reviewer" },
      { stage: "merge" },
      "findings",
      count,
      file,
    );
  }
  return output;
}

// ---------------------------------------------------------------------------
// Merge

export interface MergeOutput {
  round: number;
  created: string[];
  duplicates: MergeResult["duplicates"];
  known: MergeResult["known"];
  oscillations: MergeResult["oscillations"];
  overlapRate: number;
  raisedByVendor: Partial<Record<Vendor, number>>;
}

/** Turns raw findings into merge candidates with fingerprints and hunk ids. */
export async function toCandidates(
  ctx: RunContext,
  raw: ReadonlyArray<{
    finding: VendorFinding;
    vendor: Vendor;
    model: string;
    groupId: string | null;
  }>,
  origin: FindingOrigin,
  groups: readonly FileGroup[],
): Promise<Candidate[]> {
  const read = tipReader(ctx);
  const out: Candidate[] = [];
  for (const r of raw) {
    const content = await read(r.finding.file);
    // The engine's own reading keeps fingerprints the same across vendors; a
    // symbol the reviewer named fills in where the scan finds none.
    const symbol = enclosingSymbol(content, r.finding.lines[0]) || (r.finding.symbol ?? "");
    const hunks = r.groupId
      ? (groups.find((g) => g.id === r.groupId)?.hunks ?? [])
      : groups.flatMap((g) => g.hunks);
    const hunkIds = hunksForFinding(r.finding, hunks);
    const groupId =
      r.groupId ??
      groups.find((g) => g.hunks.some((h) => hunkIds.includes(h.id)))?.id ??
      groups.find((g) => g.files.includes(r.finding.file))?.id ??
      null;
    out.push({
      raw: r.finding,
      reportedBy: reviewerLabel(r.vendor, r.model),
      vendor: r.vendor,
      groupId,
      hunkIds,
      origin,
      fingerprint: fingerprint(r.finding.file, symbol, r.finding.title),
      symbol,
    });
  }
  return out;
}

async function symbolsOfFixed(ctx: RunContext): Promise<Map<string, string>> {
  const read = tipReader(ctx);
  const map = new Map<string, string>();
  for (const f of ctx.findings) {
    if (f.verdict !== "fixed" || !f.file || !f.lines) continue;
    map.set(f.id, enclosingSymbol(await read(f.file), f.lines[0]));
  }
  return map;
}

interface MergeCommit {
  result: Omit<MergeResult, "findings">;
  findings: Finding[];
  findingCounter: number;
}

/**
 * Merges candidates into the run's findings and announces the new ones.
 * The merge result and the findings after it are saved in one file
 * (`<name>-commit.json`) before the findings file, so a stage that resumes
 * after a crash restores that result instead of merging the same
 * candidates into their own copies. A stage that stopped before every new
 * finding was announced announces them all again when it resumes.
 */
export async function mergeInto(
  ctx: RunContext,
  candidates: readonly Candidate[] | (() => Promise<readonly Candidate[]>),
  name: string,
): Promise<Omit<MergeResult, "findings">> {
  const file = ctx.store.roundFile(ctx.round, `${name}-commit`);
  let commit = await ctx.store.readJson<MergeCommit>(file);
  if (!commit) {
    const list = typeof candidates === "function" ? await candidates() : candidates;
    const { findings, ...result } = mergeCandidates(
      ctx.findings,
      list,
      {
        runId: ctx.state.id,
        round: Math.max(1, ctx.round),
        nextId: () => ctx.nextFindingId(),
        acceptedOscillations: ctx.eng.acceptedOscillations,
        now: () => ctx.nowIso(),
        ...linesVersion(ctx),
        ...(ctx.state.request.scope === "whole" ? { noBase: true } : {}),
      },
      await symbolsOfFixed(ctx),
    );
    commit = { result, findings, findingCounter: ctx.eng.counters.finding };
    await ctx.store.writeJson(file, commit);
  }
  if (!ctx.eng.appliedMerges.includes(file)) {
    ctx.findings = commit.findings;
    ctx.eng.counters.finding = Math.max(ctx.eng.counters.finding, commit.findingCounter);
    await ctx.persist();
    for (const id of commit.result.created) {
      const f = ctx.findingById(id);
      if (f) await ctx.announceFinding(f);
    }
    // Marked as applied only after the announcements, so an engine that stops
    // between the two applies the same commit again and announces it again.
    ctx.eng.appliedMerges = [...ctx.eng.appliedMerges, file];
    await ctx.persist();
  }
  return commit.result;
}

/** The decision for findings that came back after their fix. */
export function oscillationDecision(
  ctx: RunContext,
  oscillations: MergeResult["oscillations"],
): DecisionNeeded {
  const ids = oscillations.flatMap((o) => [o.fixedId, o.returnedId]);
  const pairs = oscillations
    .map((o) => {
      const fixed = ctx.findingById(o.fixedId);
      const back = ctx.findingById(o.returnedId);
      return `${o.fixedId} (fixed in ${fixed?.fixCommit ?? "an earlier round"}: ${fixed?.title ?? ""}) came back as ${o.returnedId} (${back?.title ?? ""})`;
    })
    .join("; ");
  return new DecisionNeeded({
    kind: "oscillation",
    findingIds: ids,
    options: ["resume", "resume_waive", "cancel"],
    message: `A fixed finding came back: ${pairs}. Resume to work on it again, waive the returned finding, or cancel.`,
  });
}

/** The merge stage of a pre-push round. Raises a decision for an oscillation. */
export async function runMerge(
  ctx: RunContext,
  find: FindOutput,
  groups: readonly FileGroup[],
): Promise<MergeOutput> {
  const file = ctx.store.roundFile(ctx.round, "merge");
  const saved = await ctx.store.readJson<MergeOutput>(file);
  if (saved) return saved;
  const raw = find.tasks.flatMap((t) =>
    t.findings.map((finding) => ({
      finding,
      vendor: t.vendor,
      model: t.model,
      groupId: t.groupId,
    })),
  );
  const raisedByVendor: Partial<Record<Vendor, number>> = {};
  for (const r of raw) raisedByVendor[r.vendor] = (raisedByVendor[r.vendor] ?? 0) + 1;
  const result = await mergeInto(ctx, () => toCandidates(ctx, raw, "reviewer", groups), "merge");
  const output: MergeOutput = {
    round: ctx.round,
    created: result.created,
    duplicates: result.duplicates,
    known: result.known,
    oscillations: result.oscillations,
    overlapRate: result.overlapRate,
    raisedByVendor,
  };
  await ctx.store.writeJson(file, output);
  const pending = ctx.findings.filter((f) => f.verdict === "pending").length;
  await ctx.handoff(
    { stage: "merge" },
    { stage: "verify", role: "disprover" },
    "findings",
    pending,
    "findings.json",
  );
  return output;
}

// ---------------------------------------------------------------------------
// Verify

export function reporterVendor(f: Finding): Vendor | null {
  if (f.origin === "pr_comment") return "copilot";
  if (f.origin === "check_run") return null;
  const v = f.reportedBy.split("-")[0];
  return v === "claude" || v === "codex" || v === "copilot" ? v : null;
}

/** The vendors a disprover of `f` must not be: its reporter, when known. */
function avoidFor(f: Finding): Vendor[] {
  const reporter = reporterVendor(f);
  return reporter ? [reporter] : [];
}

const baseWorktrees = new WeakMap<RunContext, BaseWorktree>();

/**
 * Runs `fn` in a new engine-owned checkout for one run of a reproduction
 * script, and removes the checkout afterwards. A script can write anything
 * there without touching the checkout under review or the checkout that
 * parallel disprovers read.
 */
async function inScriptCheckout<T>(
  ctx: RunContext,
  name: string,
  state: CheckoutState,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  if (ctx.cancelled) throw new RunCancelled();
  const checkout = new EngineCheckout(ctx.git, join(scriptCheckoutsDir(ctx.state.id), name));
  try {
    return await fn(await checkout.ensure(state));
  } finally {
    await checkout.dispose();
  }
}

export function baseWorktreeFor(ctx: RunContext): BaseWorktree {
  if (ctx.cancelled) throw new RunCancelled();
  let wt = baseWorktrees.get(ctx);
  if (!wt) {
    wt = new BaseWorktree(ctx.git, ctx.state.baseSha ?? "HEAD", baseWorktreePath(ctx.state.id));
    baseWorktrees.set(ctx, wt);
  }
  return wt;
}

/** Removes the base checkout, if the run made one. */
export async function disposeBaseWorktree(ctx: RunContext): Promise<void> {
  const wt = baseWorktrees.get(ctx);
  if (wt) {
    baseWorktrees.delete(ctx);
    await wt.dispose();
  }
}

/** Removes every checkout the run made: the base, the read-only checkout, and script checkouts. */
export async function disposeCheckouts(ctx: RunContext): Promise<void> {
  await disposeBaseWorktree(ctx);
  readOnlyStates.delete(ctx);
  await ctx.readOnlyCheckout.dispose();
  await removeCheckout(ctx.git, scriptCheckoutsDir(ctx.state.id));
}

/** Pending findings that no disprover checks, because of the verification floor. */
export function belowFloorPending(ctx: RunContext): Finding[] {
  const floor = ctx.state.request.verifyFloor;
  return ctx.findings.filter((f) => f.verdict === "pending" && belowVerifyFloor(f, floor));
}

/**
 * Confirmed findings that would go to the fixer without the verification
 * floor. They stay confirmed. A fix that already exists still reaches the
 * confirmer, and a finding the fixer declined is already left to a person.
 */
export function heldByFloor(ctx: RunContext): Finding[] {
  if (ctx.state.request.readOnly) return [];
  const floor = ctx.state.request.verifyFloor;
  const declined = new Set(ctx.eng.declined);
  return ctx.findings.filter(
    (f) =>
      f.verdict === "confirmed" &&
      aboveNit(f) &&
      !f.fixCommit &&
      !declined.has(f.id) &&
      belowVerifyFloor(f, floor),
  );
}

/**
 * Makes each finding's floor labels match the run's floor and the finding's
 * verdict, and announces the findings that changed. A retry can move the
 * floor, and a person can waive a finding.
 */
export async function syncFloorLabels(ctx: RunContext): Promise<void> {
  const below = new Set(belowFloorPending(ctx));
  const held = new Set(heldByFloor(ctx));
  const changed: Finding[] = [];
  for (const f of ctx.findings) {
    const unverified = below.has(f) !== (f.unverifiedReason !== undefined);
    const fixHeld = held.has(f) !== (f.fixHeldReason !== undefined);
    if (!unverified && !fixHeld) continue;
    if (below.has(f)) f.unverifiedReason = "below_verify_floor";
    else delete f.unverifiedReason;
    if (held.has(f)) f.fixHeldReason = "below_verify_floor";
    else delete f.fixHeldReason;
    changed.push(f);
  }
  if (changed.length === 0) return;
  await ctx.persist();
  for (const f of changed) {
    await ctx.emit({
      type: "finding.changed",
      runId: ctx.state.id,
      finding: structuredClone(f),
      previousVerdict: f.verdict,
    });
  }
}

/** Thrown when a refused call found no model or vendor that would answer. */
class RefusalFallbackFailed extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(reasons.join(" "));
    this.name = "RefusalFallbackFailed";
  }
}

/**
 * Makes a call, and moves it when a vendor's safety filter refuses: to Codex's
 * small model, then to Claude. Claude can be the finding's reporter or the
 * fixer, so its answer waives the cross-vendor rule for this call, and the run
 * gets a notice. Other failures of the first call stay as they are.
 */
async function callWithRefusalFallback<T>(
  ctx: RunContext,
  spec: AgentCallSpec,
  subject: string,
): Promise<AgentOutcome<T>> {
  let refused: SafetyRefused;
  try {
    return await ctx.callAgent<T>(spec);
  } catch (error) {
    if (!(error instanceof SafetyRefused)) throw error;
    refused = error;
  }
  const reasons = [refused.message];
  const pinned = { ...spec, allowFallback: false, pinVendor: true };
  const attempts: AgentCallSpec[] = [];
  if (refused.vendor === "codex") {
    attempts.push({
      ...pinned,
      key: `${spec.key}-small`,
      tier: { tier: "small", reason: "A larger model's call was refused", fixed: true },
    });
  }
  if (refused.vendor !== "claude" && ctx.usable("claude")) {
    const { avoid: _reporterOrFixer, ...rest } = pinned;
    attempts.push({
      ...rest,
      key: `${spec.key}-claude`,
      vendor: "claude",
      avoid: [refused.vendor],
    });
  }
  for (const attempt of attempts) {
    try {
      const out = await ctx.callAgent<T>(attempt);
      if (out.vendor === "claude") {
        await addNotice(
          ctx,
          `Claude answered for ${subject} after a safety refusal, so that check isn't independent.`,
        );
      }
      return out;
    } catch (error) {
      if (!(error instanceof AgentFailed)) throw error;
      reasons.push(error.message);
    }
  }
  throw new RefusalFallbackFailed(reasons);
}

async function addNotice(ctx: RunContext, notice: string): Promise<void> {
  if (ctx.state.notices?.includes(notice)) return;
  ctx.state.notices = [...(ctx.state.notices ?? []), notice];
  await ctx.persist();
}

interface VerifyBatchPlan {
  batches: VerifyBatch[];
  /** Duplicate finding id to the id of the finding that a disprover reads. */
  duplicates: Record<string, string>;
}

/**
 * The stage's batches, saved before any call, so a resumed stage keeps the same
 * batches and call keys. Findings the plan doesn't hold yet get new batches.
 */
async function planBatchesFor(
  ctx: RunContext,
  pending: readonly Finding[],
  stageFile: string,
  /** False plans only the duplicates, for depths that verify each finding alone. */
  batch = true,
): Promise<VerifyBatchPlan> {
  const file = stageFile.replace(/\.json$/, "-batches.json");
  const plan = (await ctx.store.readJson<VerifyBatchPlan>(file)) ?? { batches: [], duplicates: {} };
  const planned = new Set([...plan.batches.flatMap((b) => b.ids), ...Object.keys(plan.duplicates)]);
  const fresh = pending.filter((f) => !planned.has(f.id));
  if (fresh.length === 0) return plan;
  const duplicates = rootCauseDuplicates(fresh);
  const reported = fresh.filter((f) => !duplicates.has(f.id));
  await markDuplicates(ctx, duplicates);
  if (!batch) {
    plan.duplicates = { ...plan.duplicates, ...Object.fromEntries(duplicates) };
    await ctx.store.writeJson(file, plan);
    return plan;
  }
  plan.batches.push(
    ...planVerifyBatches(reported, {
      vendorFor: (f) =>
        chooseDisprover(reporterVendor(f), ctx.state.roles, {
          crossVendor: ctx.state.request.crossVendor,
          available: ctx.availableVendors,
          profile: ctx.state.profile,
        }),
      reporterFor: reporterVendor,
      tokensFor: (f) => estimateTokens(batchFindingBlock(f)),
    }),
  );
  plan.duplicates = { ...plan.duplicates, ...Object.fromEntries(duplicates) };
  await ctx.store.writeJson(file, plan);
  return plan;
}

/**
 * The dedup pass after review: records on each duplicate the finding it
 * duplicates, so screens and exports can fold it under its primary.
 */
async function markDuplicates(
  ctx: RunContext,
  duplicates: ReadonlyMap<string, string>,
): Promise<void> {
  if (duplicates.size === 0) return;
  for (const [id, primaryId] of duplicates) {
    const finding = ctx.findingById(id);
    if (!finding || finding.duplicateOf === primaryId) continue;
    finding.duplicateOf = primaryId;
    await ctx.emit({
      type: "finding.changed",
      runId: ctx.state.id,
      finding: structuredClone(finding),
      previousVerdict: finding.verdict,
    });
  }
  const pairs = [...duplicates].map(([id, primaryId]) => `${id} into ${primaryId}`).join(", ");
  const count = duplicates.size;
  await addNotice(
    ctx,
    `The dedup pass folded ${count} ${count === 1 ? "finding" : "findings"} with the same root cause into another: ${pairs}.`,
  );
}

/**
 * Gives each duplicate its primary's outcome. A primary with no verdict leaves
 * its duplicate pending, or flagged like itself, and the next round looks again.
 */
async function followPrimaries(
  ctx: RunContext,
  duplicates: Readonly<Record<string, string>>,
): Promise<VerifyResult[]> {
  const out: VerifyResult[] = [];
  for (const [id, primaryId] of Object.entries(duplicates)) {
    const finding = ctx.findingById(id);
    const primary = ctx.findingById(primaryId);
    if (!finding || !primary || finding.verdict !== "pending") continue;
    if (primary.verdict === "pending") {
      if (primary.followUpReason && !finding.followUpReason) {
        finding.followUpReason = primary.followUpReason;
        await ctx.emit({
          type: "finding.changed",
          runId: ctx.state.id,
          finding: structuredClone(finding),
          previousVerdict: finding.verdict,
        });
      }
      continue;
    }
    const last = [...primary.history].reverse().find((h) => h.verdict === primary.verdict);
    if (!last || last.actor.kind !== "agent" || last.actor.role !== "disprover") continue;
    const evidence = `The same root cause as ${primary.id}. ${primary.evidence}`;
    const verdict = primary.verdict as "confirmed" | "disproved" | "pre-existing";
    await ctx.setVerdict(finding, verdict, last.actor, evidence, {
      ...(primary.verification ? { verification: primary.verification } : {}),
      introduced: primary.introduced,
    });
    out.push({
      findingId: id,
      vendor: last.actor.vendor as Vendor,
      model: last.actor.model ?? "",
      decision: {
        verdict,
        verification: primary.verification === "script" ? "script" : "code-reading",
        introduced: primary.introduced,
        evidence,
      },
      tipRun: null,
      baseRun: null,
    });
  }
  return out;
}

/**
 * Verifies every pending finding at or above the verification floor with a
 * disprover from another vendor. The rest stay pending and labeled.
 */
export async function verifyPending(ctx: RunContext, stageFile: string): Promise<VerifyResult[]> {
  await syncFloorLabels(ctx);
  const pending = ctx.findings.filter(
    (f) =>
      f.verdict === "pending" && f.unverifiedReason === undefined && f.followUpReason === undefined,
  );
  const repoPath = pending.length > 0 ? await readOnlyRepo(ctx) : ctx.state.request.repoPath;
  const tipState = pending.length > 0 ? await readOnlyState(ctx) : null;
  const groups = await roundGroups(ctx);
  const deps = (id: string) => ({
    runner: ctx.deps.runner,
    range: ctx.range(repoPath),
    policy: ctx.policy,
    baseWorktree: isWholeProject(ctx) ? null : baseWorktreeFor(ctx),
    signal: ctx.signal,
    inScriptCheckout: <T>(side: "tip" | "base", fn: (dir: string) => Promise<T>) => {
      const base = ctx.state.baseSha ?? "HEAD";
      const state = side === "tip" && tipState ? tipState : { commit: base, head: base };
      return inScriptCheckout(ctx, `${id}-${side}`, state, fn);
    },
  });
  /** Records why nothing can check this finding, so it waits for a person, and the run goes on. */
  const flag = async (finding: Finding, error: RefusalFallbackFailed): Promise<null> => {
    finding.followUpReason = error.reasons.join(" ").slice(0, 2000);
    await addNotice(ctx, `Finding ${finding.id} needs follow-up: no vendor would check it.`);
    await ctx.emit({
      type: "finding.changed",
      runId: ctx.state.id,
      finding: structuredClone(finding),
      previousVerdict: finding.verdict,
    });
    return null;
  };
  const apply = async (finding: Finding, result: VerifyResult): Promise<VerifyResult> => {
    const d = result.decision;
    if (d.verdict === "unverified") {
      // The finding stays pending: the run can't stop clean, and the next
      // round verifies it again.
      ctx.deps.log?.warn("A disprover couldn't verify a finding; it stays pending", {
        runId: ctx.state.id,
        findingId: finding.id,
        vendor: result.vendor,
        evidence: d.evidence.slice(0, 500),
      });
    } else {
      const rerank =
        d.verdict === "confirmed" && d.severity !== undefined && d.severity !== finding.severity
          ? d.severity
          : null;
      const evidence = rerank
        ? `${d.evidence}\nThe disprover ranked it ${rerank} against the severity anchors; the reporter said ${finding.severity}.`
        : d.evidence;
      await ctx.setVerdict(
        finding,
        d.verdict,
        { kind: "agent", vendor: result.vendor, model: result.model, role: "disprover" },
        evidence,
        {
          verification: d.verification,
          introduced: d.introduced,
          ...(rerank ? { severity: rerank } : {}),
        },
      );
    }
    return result;
  };
  /** Checks one finding in its own call. */
  const verifyOne = async (finding: Finding): Promise<VerifyResult | null> => {
    const vendor = chooseDisprover(reporterVendor(finding), ctx.state.roles, {
      crossVendor: ctx.state.request.crossVendor,
      available: ctx.availableVendors,
      profile: ctx.state.profile,
    });
    let result: VerifyResult | null;
    try {
      result = await verifyFinding(finding, vendor, {
        ...deps(finding.id),
        related: relatedFindings([finding], ctx.findings),
        ...(runDepth(ctx.state.request) === "standard" ? { standard: true } : {}),
        scratchDirFor: (id) => ctx.store.scratchDir(id),
        timeoutMs: ctx.timeouts.disprover,
        callDisprover: async (v, f, request) => {
          const tier = callTier(ctx, "disprover", groups, f.file ? [f.file] : []);
          const out = await callWithRefusalFallback<VerifyOutput>(
            ctx,
            {
              key: `verify-${f.id}`,
              role: "disprover",
              vendor: v,
              method: "verify",
              request,
              groupId: f.groupId,
              estimateTokens: estimateTokens(request.prompt) + 6000,
              allowFallback: true,
              ...(tier ? { tier } : {}),
              ...(ctx.state.request.crossVendor ? { avoid: avoidFor(f) } : {}),
            },
            `finding ${f.id}`,
          );
          return {
            vendor: out.vendor,
            model: out.model,
            output: out.output,
            ...(out.toolErrors ? { toolErrors: out.toolErrors } : {}),
          };
        },
      });
    } catch (error) {
      if (!(error instanceof RefusalFallbackFailed)) throw error;
      return flag(finding, error);
    }
    return result ? apply(finding, result) : null;
  };
  /** Checks a batch's findings that are still open in one call, under a key that outlives a restart. */
  const verifyBatch = async (batch: VerifyBatch): Promise<Array<VerifyResult | null>> => {
    const findings = batch.ids.flatMap((id) => {
      const f = ctx.findingById(id);
      return f && pending.includes(f) ? [f] : [];
    });
    const first = findings[0];
    if (!first) return [];
    // The key names the batch as planned, so a saved call still answers when
    // some of its verdicts were applied before a restart.
    const key = `verify-batch-${batchKey(batch.ids)}`;
    const scratchDir = ctx.store.scratchDir(`batch-${batchKey(batch.ids)}`);
    await mkdir(scratchDir, { recursive: true });
    const baseDir = isWholeProject(ctx) ? null : await baseWorktreeFor(ctx).ensure();
    const files = [...new Set(findings.flatMap((f) => (f.file ? [f.file] : [])))];
    const prompt = batchDisproverPrompt({
      range: ctx.range(repoPath),
      findings,
      related: relatedFindings(findings, ctx.findings),
      scratchDir,
      baseWorktree: baseDir,
      policySection: policyPromptSection(ctx.policy, files.length > 0 ? files : undefined),
    });
    const tier = callTier(ctx, "disprover", groups, files);
    const growth = Math.min(BATCH_TIMEOUT_FACTOR, 1 + (findings.length - 1) / 4);
    let out: AgentOutcome<VerifyBatchOutput>;
    try {
      out = await callWithRefusalFallback<VerifyBatchOutput>(
        ctx,
        {
          key,
          role: "disprover",
          vendor: chooseDisprover(reporterVendor(first), ctx.state.roles, {
            crossVendor: ctx.state.request.crossVendor,
            available: ctx.availableVendors,
            profile: ctx.state.profile,
          }),
          method: "verifyBatch",
          request: {
            prompt,
            repoPath,
            ...(baseDir ? { extraDirs: [baseDir] } : {}),
            scratchDir,
            toolPolicy: "read-only",
            timeoutMs: Math.round(ctx.timeouts.disprover * growth),
            effort: batchEffort(findings.length),
          },
          groupId: batch.groupId,
          estimateTokens: estimateTokens(prompt) + 6000 * growth,
          allowFallback: true,
          ...(tier ? { tier } : {}),
          ...(ctx.state.request.crossVendor ? { avoid: avoidFor(first) } : {}),
        },
        `the findings ${findings.map((f) => f.id).join(", ")}`,
      );
    } catch (error) {
      if (!(error instanceof RefusalFallbackFailed)) throw error;
      // One finding must not flag its whole group, so each one tries alone
      // before anything is flagged. They go one at a time in this batch's
      // slot, so the stage never runs more calls than its concurrency.
      if (findings.length === 1) return [await flag(first, error)];
      return mapLimit(findings, 1, verifyOne);
    }
    const results: Array<VerifyResult | null> = [];
    for (const finding of findings) {
      const verdict = out.output.verdicts.find((v) => v.id === finding.id);
      if (!verdict) {
        ctx.deps.log?.warn("A disprover gave no verdict for a finding; it stays pending", {
          runId: ctx.state.id,
          findingId: finding.id,
          vendor: out.vendor,
        });
        results.push(null);
        continue;
      }
      const { id: _id, ...output } = verdict;
      const result = await judgeAnswer(
        finding,
        {
          vendor: out.vendor,
          model: out.model,
          output,
          ...(out.toolErrors ? { toolErrors: out.toolErrors } : {}),
        },
        scratchDir,
        deps(finding.id),
      );
      results.push(await apply(finding, result));
    }
    return results;
  };
  let results: Array<VerifyResult | null>;
  if (runDepth(ctx.state.request) === "standard") {
    const plan = await planBatchesFor(ctx, pending, stageFile);
    const perBatch = await mapLimit(
      plan.batches,
      ctx.state.request.concurrency ?? VERIFY_CONCURRENCY,
      verifyBatch,
    );
    results = [...perBatch.flat(), ...(await followPrimaries(ctx, plan.duplicates))];
  } else {
    // Each finding gets its own call, but a duplicate still takes its
    // primary's verdict, so one root cause can't get two verdicts.
    const plan = await planBatchesFor(ctx, pending, stageFile, false);
    const primaries = pending.filter((f) => plan.duplicates[f.id] === undefined);
    results = [
      ...(await mapLimit(
        primaries,
        ctx.state.request.concurrency ?? VERIFY_CONCURRENCY,
        verifyOne,
      )),
      ...(await followPrimaries(ctx, plan.duplicates)),
    ];
  }
  const done = results.filter((r): r is VerifyResult => r !== null);
  // A resumed stage verifies only what is still pending, so the results
  // from before the restart are kept in the stage file.
  const earlier = (await ctx.store.readJson<VerifyResult[]>(stageFile)) ?? [];
  const redone = new Set(done.map((r) => r.findingId));
  await ctx.store.writeJson(stageFile, [
    ...earlier.filter((r) => !redone.has(r.findingId)),
    ...done,
  ]);
  const confirmed = done.filter((r) => r.decision.verdict === "confirmed").length;
  await ctx.handoff(
    { stage: "verify", role: "disprover" },
    { stage: "fix", vendor: ctx.state.roles.fixer, role: "fixer" },
    "findings",
    confirmed,
    stageFile,
  );
  return done;
}

/** The recorded reason a selected finding passes the verification floor. */
const TRIAGE_REASON = "A triage call selected it as real and worth fixing.";

/**
 * Asks one read-only call which unchecked P3 findings below the floor are real
 * and worth fixing. Those become confirmed and go to the fixer; the rest stay
 * pending and labeled. Only `standard` runs that fix do this, and a failed call
 * leaves the labels and the run as they were. Returns the number selected.
 */
export async function triageBelowFloor(ctx: RunContext): Promise<number> {
  if (ctx.state.request.readOnly || runDepth(ctx.state.request) !== "standard") return 0;
  const triaged = new Set(ctx.eng.triaged);
  const unasked = belowFloorPending(ctx).filter(
    (f) =>
      f.severity === "P3" && !isExternal(f) && f.followUpReason === undefined && !triaged.has(f.id),
  );
  if (unasked.length === 0) return 0;
  // Saved before any call, so a resumed stage keeps the same call keys.
  const file = ctx.store.roundFile(ctx.round, "triage");
  const plan = (await ctx.store.readJson<{ batches: string[][] }>(file)) ?? { batches: [] };
  const planned = new Set(plan.batches.flat());
  const fresh = unasked.filter((f) => !planned.has(f.id));
  if (fresh.length > 0) {
    plan.batches.push(
      ...splitByTokens(fresh, (f) => estimateTokens(triageLine(f))).map((part) =>
        part.map((f) => f.id),
      ),
    );
    await ctx.store.writeJson(file, plan);
  }
  const repoPath = await readOnlyRepo(ctx);
  const open = new Set(unasked.map((f) => f.id));
  for (const ids of plan.batches) {
    const findings = ids.flatMap((id) => {
      const f = ctx.findingById(id);
      return f && open.has(id) ? [f] : [];
    });
    if (findings.length === 0) continue;
    const prompt = triagePrompt({ range: ctx.range(repoPath), findings });
    try {
      const out = await callWithRefusalFallback<VerifyBatchOutput>(
        ctx,
        {
          key: `triage-${batchKey(ids)}`,
          role: "disprover",
          vendor: chooseDisprover(null, ctx.state.roles, {
            crossVendor: true,
            available: ctx.availableVendors,
            profile: ctx.state.profile,
          }),
          method: "verifyBatch",
          request: {
            prompt,
            repoPath,
            toolPolicy: "read-only",
            timeoutMs: ctx.timeouts.disprover,
            effort: "medium",
          },
          groupId: null,
          estimateTokens: estimateTokens(prompt) + 6000,
          allowFallback: true,
          ...(ctx.state.request.modelTier
            ? { tier: { tier: "medium" as const, reason: "A P3 triage call", fixed: true } }
            : {}),
        },
        "the P3 triage",
      );
      for (const finding of findings) {
        const answer = out.output.verdicts.find((v) => v.id === finding.id);
        if (answer?.verdict !== "confirmed" || answer.evidence.trim() === "") continue;
        finding.floorBypassReason = TRIAGE_REASON;
        await ctx.setVerdict(
          finding,
          "confirmed",
          { kind: "agent", vendor: out.vendor, model: out.model, role: "disprover" },
          answer.evidence,
          { verification: "code-reading", introduced: finding.introduced },
        );
      }
    } catch (error) {
      if (
        !(error instanceof AgentFailed) &&
        !(error instanceof RefusalFallbackFailed) &&
        !(error instanceof RoleDenied)
      ) {
        throw error;
      }
      ctx.deps.log?.warn("A P3 triage call failed; its findings stay labeled", {
        runId: ctx.state.id,
        error: (error as Error).message.slice(0, 500),
      });
    }
  }
  ctx.eng.triaged = [...ctx.eng.triaged, ...unasked.map((f) => f.id)];
  await syncFloorLabels(ctx);
  const ids = plan.batches.flat();
  const selected = ctx.findings.filter(
    (f) => ids.includes(f.id) && f.floorBypassReason !== undefined,
  ).length;
  await addNotice(
    ctx,
    `A triage call read ${ids.length} P3 ${ids.length === 1 ? "finding" : "findings"} below the verification floor and sent ${selected} to the fixer.`,
  );
  return selected;
}

// ---------------------------------------------------------------------------
// Sweep

/** The vendor that runs the pattern sweep: the first reviewer other than Claude. */
export function chooseSweeper(reviewers: readonly Vendor[]): Vendor {
  return reviewers.find((v) => v !== "claude") ?? reviewers[0] ?? "codex";
}

/** The pattern sweep: confirmed findings of this round become patterns. Returns created finding ids. */
export async function runSweep(
  ctx: RunContext,
  groups: readonly FileGroup[],
): Promise<MergeOutput | null> {
  const file = ctx.store.roundFile(ctx.round, "sweep");
  // A sweep with no patterns saves `{ "skipped": true }`, since `readJson`
  // can't tell a saved `null` from a missing file.
  const saved = await ctx.store.readJson<MergeOutput | { skipped: true }>(file);
  if (saved) return "skipped" in saved ? null : saved;
  const patterns = ctx.findings.filter(
    (f) =>
      f.verdict === "confirmed" &&
      !belowVerifyFloor(f, ctx.state.request.verifyFloor) &&
      f.history.some((h) => h.verdict === "confirmed" && h.round === ctx.round),
  );
  if (patterns.length === 0) {
    await ctx.store.writeJson(file, { skipped: true });
    return null;
  }
  const vendor = chooseSweeper(ctx.state.roles.reviewer);
  const diffBase = reviewDiffBase(ctx);
  // The whole project doesn't fit a prompt, so a sweep of it reads the checkout.
  // Otherwise, excluded files stay out of the diff the sweep reads.
  const diff = reviewsWholeProject(ctx)
    ? ""
    : await ctx.git.diffForPrompt(
        diffBase,
        await diffTip(ctx),
        hasExclusions(ctx.state.request, ctx.policy)
          ? [...new Set(groups.flatMap((g) => g.files))]
          : [],
      );
  const repoPath = await readOnlyRepo(ctx);
  // A large diff can push the prompt past a model's context limit, so the
  // sweeper reads it with Git instead.
  const inline = estimateTokens(diff) <= SWEEP_DIFF_TOKEN_LIMIT;
  const diffFile = ctx.store.path(`rounds/${ctx.round}/sweep.diff`);
  if (!inline) {
    await mkdir(dirname(diffFile), { recursive: true });
    await writeFile(diffFile, diff);
  }
  const prompt = sweepPrompt({
    standard: runDepth(ctx.state.request) === "standard",
    range: reviewsFixDiffOnly(ctx) ? fixDiffRange(ctx, repoPath, diffBase) : ctx.range(repoPath),
    patterns,
    diff: inline ? diff : "",
    ...(inline ? {} : { changedFiles: [...new Set(groups.flatMap((g) => g.files))], diffFile }),
    policySection: policyPromptSection(ctx.policy),
  });
  const sweepTier = callTier(ctx, "sweeper", groups);
  const out = await ctx.callAgent<SweepOutput>({
    key: "sweep",
    role: "sweeper",
    vendor,
    method: "sweep",
    request: { prompt, repoPath, toolPolicy: "read-only" },
    groupId: null,
    estimateTokens: estimateTokens(prompt) + 3000,
    allowFallback: true,
    ...(sweepTier ? { tier: sweepTier } : {}),
  });
  const raw = out.output.findings.map((finding) => ({
    finding,
    vendor: out.vendor,
    model: out.model,
    groupId: null,
  }));
  const result = await mergeInto(ctx, () => toCandidates(ctx, raw, "sweep", groups), "sweep");
  const output: MergeOutput = {
    round: ctx.round,
    created: result.created,
    duplicates: result.duplicates,
    known: result.known,
    oscillations: result.oscillations,
    overlapRate: result.overlapRate,
    raisedByVendor: { [out.vendor]: raw.length },
  };
  await ctx.store.writeJson(file, output);
  await ctx.handoff(
    { stage: "sweep", vendor: out.vendor, role: "sweeper" },
    { stage: "verify", role: "disprover" },
    "findings",
    result.created.length,
    file,
  );
  return output;
}

// ---------------------------------------------------------------------------
// Fix, gate, confirm

export interface FixBatchRecord {
  findingIds: string[];
  before: string;
  after: string;
  commits: string[];
  output: FixOutput;
}

export interface FixRecord {
  attempt: number;
  preFixSha: string;
  batches: FixBatchRecord[];
}

/** Findings the fixer should work on: confirmed, above `nit`, at or above the floor, and not declined. */
export function fixTargets(ctx: RunContext): Finding[] {
  const declined = new Set(ctx.eng.declined);
  const floor = ctx.state.request.verifyFloor;
  return ctx.findings.filter(
    (f) =>
      f.verdict === "confirmed" &&
      aboveNit(f) &&
      !declined.has(f.id) &&
      !belowVerifyFloor(f, floor),
  );
}

/** The name of a fix or gate attempt's files: the decision epoch and the attempt. */
export function attemptName(ctx: RunContext, stage: "fix" | "gate"): string {
  return `${stage}-${ctx.eng.fixEpoch}-${ctx.eng.gateAttempts + 1}`;
}

/** A short, stable key for a batch: a hash of its sorted finding ids. */
export function batchKey(findingIds: readonly string[]): string {
  return createHash("sha1")
    .update([...findingIds].sort().join(","))
    .digest("hex")
    .slice(0, 12);
}

/** Splits the targets into batches: one per group, or one for a gate retry. */
function planBatches(targets: readonly Finding[], gateFailure?: string): string[][] {
  if (gateFailure) return [targets.map((f) => f.id)];
  const byGroup = new Map<string, string[]>();
  for (const f of targets) {
    const k = f.groupId ?? "none";
    byGroup.set(k, [...(byGroup.get(k) ?? []), f.id]);
  }
  return [...byGroup.keys()].sort().map((k) => byGroup.get(k) ?? []);
}

/**
 * Applies one batch's outcome to the findings. Idempotent, so a resumed run
 * can apply a saved batch again. The fixer may mark only the batch's own
 * findings. A declined finding keeps the fixer's reason, or a note that it
 * gave none, and is left to a person: asking again would only repeat the
 * decline in every round.
 */
async function applyBatch(ctx: RunContext, batch: FixBatchRecord): Promise<void> {
  const inBatch = new Set(batch.findingIds);
  const fixedIds = new Set(batch.output.fixed.filter((id) => inBatch.has(id)));
  for (const id of batch.findingIds) {
    const finding = ctx.findingById(id);
    if (finding && fixedIds.has(id) && batch.commits.length > 0) finding.fixCommit = batch.after;
  }
  for (const nf of batch.output.notFixed) {
    const reason = nf.reason.trim();
    if (!inBatch.has(nf.id) || fixedIds.has(nf.id)) continue;
    if (ctx.eng.declined.includes(nf.id)) continue;
    ctx.eng.declined = [...ctx.eng.declined, nf.id];
    const finding = ctx.findingById(nf.id);
    if (finding) {
      await ctx.setVerdict(
        finding,
        finding.verdict,
        { kind: "agent", vendor: ctx.state.roles.fixer, role: "fixer" },
        reason
          ? `The fixer declined to fix it: ${reason}`
          : "The fixer declined to fix it and gave no reason.",
      );
    }
  }
  ctx.state.tipSha = batch.after;
  await ctx.persist();
}

/**
 * The uncommitted changes in the checkout under review, as sorted
 * `git status` entries, without the run directory and Python bytecode.
 */
async function uncommittedStatus(ctx: RunContext): Promise<string[]> {
  return (await snapshotTree(ctx.deps.runner, ctx.state.request.repoPath, [ctx.store.dir])).status;
}

/**
 * The fix stage: the fixer fixes confirmed findings in batches per group and
 * commits. The batch plan and each batch's outcome are saved as they happen,
 * so a resumed stage keeps the same batches and the commits each one made.
 */
export async function runFix(
  ctx: RunContext,
  targets: readonly Finding[],
  gateFailure?: string,
): Promise<FixRecord> {
  const name = attemptName(ctx, "fix");
  const file = ctx.store.roundFile(ctx.round, name);
  const saved = await ctx.store.readJson<FixRecord>(file);
  if (saved) return saved;
  const branch = ctx.eng.tipRef;
  if (!branch) throw new Error("The run has no tip branch to fix on.");
  const current = await ctx.git.currentBranch();
  if (current !== branch)
    throw new Error(
      `The fixer commits to ${branch}, but ${current ?? "a detached HEAD"} is checked out.`,
    );
  const preFixSha = ctx.eng.preFixSha ?? (await ctx.git.head());
  ctx.eng.preFixSha = preFixSha;
  await ctx.persist();

  const planFile = ctx.store.roundFile(ctx.round, `${name}-plan`);
  let plan = await ctx.store.readJson<string[][]>(planFile);
  if (!plan) {
    plan = planBatches(targets, gateFailure);
    await ctx.store.writeJson(planFile, plan);
  }
  // A retry can raise the floor after the plan was saved. A batch the fixer
  // already finished stays, and the others lose what the floor now holds.
  const held = new Set(heldByFloor(ctx).map((f) => f.id));
  if (held.size > 0) {
    const kept: string[][] = [];
    for (const ids of plan) {
      const key = `${name}-${batchKey(ids)}`;
      const finished =
        (await ctx.store.readJson(ctx.store.roundFile(ctx.round, key))) ??
        (await ctx.store.readJson(ctx.store.roundFile(ctx.round, `calls/${key}`)));
      const rest = finished ? ids : ids.filter((id) => !held.has(id));
      if (rest.length > 0) kept.push(rest);
    }
    plan = kept;
  }

  await ctx.planTasks(
    plan.map((ids) => {
      const groupId = ctx.findingById(ids[0] ?? "")?.groupId ?? null;
      return {
        key: `${name}-${batchKey(ids)}`,
        role: "fixer" as const,
        groupId,
        label: `Fix ${ids.length === 1 ? ids[0] : `${ids.length} findings`}`,
        vendor: ctx.state.roles.fixer,
      };
    }),
    "fix",
  );
  const record: FixRecord = { attempt: ctx.eng.gateAttempts + 1, preFixSha, batches: [] };
  for (const ids of plan) {
    const key = `${name}-${batchKey(ids)}`;
    const batchFile = ctx.store.roundFile(ctx.round, key);
    let batch = await ctx.store.readJson<FixBatchRecord>(batchFile);
    if (!batch) {
      const findings = ids.flatMap((id) => ctx.findingById(id) ?? []);
      // HEAD before the fixer runs is saved first. An engine that stops after
      // the fixer commits, but before the batch file is saved, then still
      // counts those commits as the batch's when the stage resumes.
      const startFile = ctx.store.roundFile(ctx.round, `${key}-start`);
      let start = await ctx.store.readJson<{ before: string; status?: string[] }>(startFile);
      if (!start) {
        start = { before: await ctx.git.head(), status: await uncommittedStatus(ctx) };
        await ctx.store.writeJson(startFile, start);
      }
      const before = start.before;
      const prompt = fixerPrompt({
        standard: runDepth(ctx.state.request) === "standard",
        range: ctx.range(),
        findings,
        gateFailure,
        policySection: policyPromptSection(
          ctx.policy,
          findings.flatMap((f) => (f.file ? [f.file] : [])),
        ),
      });
      // A gate failure can be anywhere in the change, so that call covers every group.
      const fixTier = callTier(
        ctx,
        "fixer",
        await roundGroups(ctx),
        gateFailure ? undefined : findings.flatMap((f) => (f.file ? [f.file] : [])),
      );
      const out = await ctx.callAgent<FixOutput>({
        key,
        role: "fixer",
        vendor: ctx.state.roles.fixer,
        method: "fix",
        request: { prompt, repoPath: ctx.state.request.repoPath, toolPolicy: "write" },
        groupId: findings[0]?.groupId ?? null,
        estimateTokens: estimateTokens(prompt) + 8000,
        allowFallback: false,
        ...(fixTier ? { tier: fixTier } : {}),
      });
      const after = await ctx.git.head();
      if (!(await ctx.git.ok(["merge-base", "--is-ancestor", before, after]))) {
        throw new Error(
          `The fixer rewrote history on ${branch}: ${before} is no longer an ancestor of ${after}.`,
        );
      }
      // Edits the fixer didn't commit would reach the gate, which tests the
      // checkout, but not the confirmer's diff or the push.
      const was = new Set(start.status ?? []);
      const leftover = (await uncommittedStatus(ctx)).filter((s) => !was.has(s));
      if (leftover.length > 0) {
        const shown = leftover.slice(0, 10).map((s) => s.slice(3));
        throw new Error(
          `The fixer left changes it didn't commit in ${ctx.state.request.repoPath}: ` +
            `${shown.join(", ")}${leftover.length > 10 ? ", ..." : ""}. ` +
            "Commit or discard them, then start the run again.",
        );
      }
      const commits = after === before ? [] : await ctx.git.commitsBetween(before, after);
      batch = { findingIds: ids, before, after, commits, output: out.output };
      await ctx.store.writeJson(batchFile, batch);
    }
    record.batches.push(batch);
    await applyBatch(ctx, batch);
  }
  await ctx.store.writeJson(file, record);
  const fixed = plan.flat().filter((id) => ctx.findingById(id)?.fixCommit).length;
  await ctx.handoff(
    { stage: "fix", vendor: ctx.state.roles.fixer, role: "fixer" },
    { stage: "gate" },
    "fixes",
    fixed,
    file,
  );
  return record;
}

/** Logs the untracked files a gate run left in the checkout under review. */
export function warnLeftovers(ctx: RunContext, run: GateRun): void {
  if (!run.leftovers?.length) return;
  ctx.deps.log?.warn(
    "Untracked files appeared in the checkout while the gate ran; the engine left them in place",
    { runId: ctx.state.id, files: run.leftovers.slice(0, 20) },
  );
}

export interface GateRecord {
  attempt: number;
  run: GateRun;
  regressed: boolean;
  report: string;
}

/**
 * The gate stage: reruns tests and lint and compares with the baseline.
 * Returns the failure report for the fixer when a regression appeared.
 */
export async function runGateStage(ctx: RunContext, nextStage: Stage): Promise<GateRecord> {
  const attempt = ctx.eng.gateAttempts + 1;
  const file = ctx.store.roundFile(ctx.round, attemptName(ctx, "gate"));
  const saved = await ctx.store.readJson<GateRecord>(file);
  if (saved) return saved;
  const baseline = (await ctx.store.readJson<{ baseline: GateRun }>("preflight.json"))
    ?.baseline ?? { passed: true, commands: [] };
  const run = await runGate(ctx.policy, {
    repoPath: ctx.state.request.repoPath,
    shell: ctx.shell,
    git: ctx.deps.runner,
    signal: ctx.signal,
  });
  warnLeftovers(ctx, run);
  const comparison = compareGate(baseline, run);
  const record: GateRecord = {
    attempt,
    run,
    regressed: comparison.regressed,
    report: formatRegressions(comparison),
  };
  await ctx.store.writeJson(file, record);
  await ctx.handoff(
    { stage: "gate" },
    { stage: comparison.regressed ? "fix" : nextStage },
    "gate_results",
    run.commands.length,
    file,
  );
  return record;
}

export interface ConfirmRecord {
  confirmer: Vendor | null;
  fixedIds: string[];
  incomplete: Array<{ id: string; reason: string }>;
  created: string[];
}

/**
 * The vendor that confirms fixes the `writers` wrote: the round's confirmer
 * when it wrote none of them, or the next available vendor in the fallback
 * order, preferring one that can take the role. `null` when every available
 * vendor wrote some.
 */
export function chooseConfirmer(
  confirmer: Vendor,
  writers: readonly Vendor[],
  available: readonly Vendor[],
): Vendor | null {
  if (!writers.includes(confirmer)) return confirmer;
  const others = FALLBACK_ORDER.filter((v) => available.includes(v) && !writers.includes(v));
  return others.find((v) => VENDOR_ROLES[v].includes("confirmer")) ?? others[0] ?? null;
}

/** The confirm stage: a reviewer from another vendor checks the fix diff. */
export async function runConfirm(
  ctx: RunContext,
  groups: readonly FileGroup[],
): Promise<ConfirmRecord> {
  const file = ctx.store.roundFile(ctx.round, "confirm");
  const saved = await ctx.store.readJson<ConfirmRecord>(file);
  if (saved) return saved;
  const preFixSha = ctx.eng.preFixSha;
  // The findings to confirm are chosen once and saved before any verdict
  // changes: a stage that resumes after some verdicts were set would
  // otherwise find nothing left to confirm and skip the confirmer's
  // findings.
  const targetsFile = ctx.store.roundFile(ctx.round, "confirm-targets");
  let targets = await ctx.store.readJson<{ ids: string[] }>(targetsFile);
  if (!targets) {
    const ids = preFixSha
      ? ctx.findings.filter((f) => f.verdict === "confirmed" && f.fixCommit).map((f) => f.id)
      : [];
    targets = { ids };
    await ctx.store.writeJson(targetsFile, targets);
  }
  const fixed = targets.ids.flatMap((id) => ctx.findingById(id) ?? []);
  if (fixed.length === 0 || !preFixSha) {
    const empty: ConfirmRecord = { confirmer: null, fixedIds: [], incomplete: [], created: [] };
    await ctx.store.writeJson(file, empty);
    return empty;
  }
  const head = await ctx.git.head();
  const fixDiff = await ctx.git.diffForPrompt(preFixSha, head);
  const repoPath = await readOnlyRepo(ctx);
  const prompt = confirmerPrompt({
    range: ctx.range(repoPath),
    findings: fixed,
    fixDiff,
    policySection: policyPromptSection(ctx.policy),
    standard: runDepth(ctx.state.request) === "standard",
  });
  const crossVendor = ctx.state.request.crossVendor;
  const fixer = ctx.state.roles.fixer;
  // An assignment during the round can move the fixer role away from the
  // vendor that wrote the fixes, so the rule follows the vendors that wrote them.
  const writers = ctx.eng.roundFixers.length > 0 ? ctx.eng.roundFixers : [fixer];
  let vendor = fixer;
  if (crossVendor) {
    const chosen = chooseConfirmer(ctx.state.roles.confirmer, writers, ctx.availableVendors);
    if (!chosen && writers.length > 1) {
      throw new DecisionNeeded({
        kind: "ceiling",
        findingIds: [],
        options: ["resume", "cancel"],
        message: `${writers.join(" and ")} both wrote fixes this round, and no other vendor can confirm them: a fix is never checked by the vendor that wrote it. Resume to start the next round, where one vendor writes the fixes, or cancel.`,
      });
    }
    // A run with one vendor still gets its confirmer, as `assignRoles` allows.
    vendor = chosen ?? ctx.state.roles.confirmer;
  }
  // The confirmer reads the whole fix diff, which can reach past the findings' files.
  const confirmTier = callTier(ctx, "confirmer", groups, [
    ...new Set([
      ...fixed.flatMap((f) => (f.file ? [f.file] : [])),
      ...parseDiff(fixDiff).map((f) => f.path),
    ]),
  ]);
  let out: AgentOutcome<ConfirmOutput>;
  try {
    out = await callWithRefusalFallback<ConfirmOutput>(
      ctx,
      {
        key: "confirm",
        role: "confirmer",
        vendor,
        method: "confirm",
        request: { prompt, repoPath, toolPolicy: "read-only" },
        groupId: null,
        estimateTokens: estimateTokens(prompt) + 3000,
        allowFallback: true,
        // Without the rule, the fixer confirms, whoever holds the confirmer role.
        ...(crossVendor ? { avoid: writers } : { pinVendor: true }),
        ...(confirmTier ? { tier: confirmTier } : {}),
      },
      "the fix confirmation",
    );
  } catch (error) {
    if (!(error instanceof RefusalFallbackFailed)) throw error;
    throw new AgentFailed("confirmer", vendor, error.message);
  }
  const actor = { kind: "agent" as const, vendor: out.vendor, model: out.model, role: "confirmer" };
  const incomplete = new Map(out.output.incomplete.map((i) => [i.id, i.reason]));
  const fixedIds: string[] = [];
  for (const f of fixed) {
    // A finding whose verdict this stage already set before a restart.
    if (f.verdict === "fixed") {
      fixedIds.push(f.id);
      continue;
    }
    if (f.verdict !== "confirmed" || !f.fixCommit) continue;
    const reason = incomplete.get(f.id);
    if (reason !== undefined) {
      await ctx.setVerdict(
        f,
        "confirmed",
        actor,
        `The fix in ${f.fixCommit ?? "?"} is incomplete: ${reason}`,
        { fixCommit: undefined },
      );
    } else {
      await ctx.setVerdict(
        f,
        "fixed",
        actor,
        `Fixed in ${f.fixCommit ?? head}; the confirmer found the fix complete.`,
      );
      fixedIds.push(f.id);
    }
  }
  const raw = out.output.findings.map((finding) => ({
    finding,
    vendor: out.vendor,
    model: out.model,
    groupId: null,
  }));
  const merged = await mergeInto(ctx, () => toCandidates(ctx, raw, "confirmer", groups), "confirm");
  const record: ConfirmRecord = {
    confirmer: out.vendor,
    fixedIds,
    incomplete: out.output.incomplete,
    created: merged.created,
  };
  await ctx.store.writeJson(file, record);
  await ctx.handoff(
    { stage: "confirm", vendor: out.vendor, role: "confirmer" },
    { stage: "find" },
    "findings",
    merged.created.length,
    file,
  );
  if (merged.oscillations.length > 0) throw oscillationDecision(ctx, merged.oscillations);
  return record;
}

// ---------------------------------------------------------------------------
// Round summary

/** Builds the round's summary from the findings and the round's usage. */
export function buildRoundSummary(
  ctx: RunContext,
  raised: Partial<Record<Vendor, number>>,
  overlapRate: number,
): RoundSummary {
  const round = ctx.round;
  const perVendor: Partial<Record<Vendor, VendorRoundStats>> = {};
  const stats = (v: Vendor): VendorRoundStats => {
    let s = perVendor[v];
    if (!s) {
      const usage = ctx.eng.roundUsage[v];
      s = {
        raised: raised[v] ?? 0,
        confirmed: 0,
        disproved: 0,
        tokensIn: Math.round(usage?.tokensIn ?? 0),
        tokensOut: Math.round(usage?.tokensOut ?? 0),
        premiumRequests: usage?.premiumRequests ?? 0,
        ...(usage?.aiCredits !== undefined ? { aiCredits: usage.aiCredits } : {}),
        costUsd: usage?.costUsd ?? 0,
      };
      perVendor[v] = s;
    }
    return s;
  };
  for (const v of Object.keys(raised) as Vendor[]) stats(v);
  for (const v of Object.keys(ctx.eng.roundUsage) as Vendor[]) stats(v);
  let fixed = 0;
  for (const f of ctx.findings) {
    const reporter = reporterVendor(f);
    for (const h of f.history) {
      if (h.round !== round) continue;
      if (reporter && h.verdict === "confirmed" && h.actor.role === "disprover")
        stats(reporter).confirmed += 1;
      if (reporter && h.verdict === "disproved") stats(reporter).disproved += 1;
      if (h.verdict === "fixed") fixed += 1;
    }
  }
  const costUsd = Object.values(perVendor).reduce((n, s) => n + (s?.costUsd ?? 0), 0);
  return {
    runId: ctx.state.id,
    round,
    perVendor,
    fixed,
    overlapRate: Math.min(1, Math.max(0, overlapRate)),
    costUsd,
    startedAt: ctx.eng.roundStartedAt ?? ctx.nowIso(),
    finishedAt: ctx.nowIso(),
  };
}

/** Findings this round confirmed above `nit`. */
export function confirmedThisRound(ctx: RunContext): Finding[] {
  return ctx.findings.filter(
    (f) =>
      aboveNit(f) &&
      !belowVerifyFloor(f, ctx.state.request.verifyFloor) &&
      f.history.some(
        (h) => h.round === ctx.round && h.verdict === "confirmed" && h.actor.role === "disprover",
      ),
  );
}

export { computeGroups as regroup };

// ---------------------------------------------------------------------------
// Root causes

/**
 * The optional last step of a run (`request.rootCauses`): one read-only call
 * that clusters the confirmed and fixed findings by root cause, in a
 * suggested fix order, stored as `state.rootCauses`. It reads only the
 * findings' titles, failure cases, and locations. A duplicate goes under its
 * primary's cause. A failed call leaves a notice and never fails the run.
 */
export async function summarizeRootCauses(ctx: RunContext): Promise<void> {
  if (!ctx.state.request.rootCauses || ctx.state.rootCauses) return;
  const confirmed = ctx.findings.filter(
    (f) => (f.verdict === "confirmed" || f.verdict === "fixed") && f.duplicateOf === undefined,
  );
  if (confirmed.length === 0) return;
  const prompt = clusterPrompt({ findings: confirmed });
  let out: AgentOutcome<ClusterOutput>;
  try {
    out = await ctx.callAgent<ClusterOutput>({
      key: "root-causes",
      role: "sweeper",
      vendor:
        ctx.state.roles.reviewer.find((v) => v !== "claude") ??
        ctx.state.roles.reviewer[0] ??
        "codex",
      method: "cluster",
      request: {
        prompt,
        repoPath: ctx.state.request.repoPath,
        toolPolicy: "read-only",
        effort: "low",
      },
      groupId: null,
      estimateTokens: estimateTokens(prompt) + 40 * confirmed.length + 1000,
      allowFallback: true,
      ...(ctx.state.request.modelTier
        ? { tier: { tier: "small" as const, reason: "The root-cause summary", fixed: true } }
        : {}),
    });
  } catch (error) {
    if (
      !(error instanceof AgentFailed) &&
      !(error instanceof RoleDenied) &&
      !(error instanceof SafetyRefused)
    ) {
      throw error;
    }
    ctx.deps.log?.warn("The root-cause call failed; the run has no root-cause summary", {
      runId: ctx.state.id,
      error: (error as Error).message.slice(0, 500),
    });
    await addNotice(ctx, "The root-cause summary call failed, so the run has no summary.");
    return;
  }
  const causes = rootCausesFrom(out.output, confirmed, ctx.findings);
  ctx.state.rootCauses = {
    createdAt: ctx.nowIso(),
    round: Math.max(0, ctx.round),
    causes,
    rationale: out.output.rationale,
  };
  await ctx.persist();
}

/**
 * Checks a root-cause answer against the findings sent: drops unknown and
 * repeated ids and empty causes, puts each missed finding under a cause of
 * its own, adds duplicates under their primary's cause, and numbers the
 * causes 1 and up in the answer's order.
 */
export function rootCausesFrom(
  output: ClusterOutput,
  sent: readonly Finding[],
  all: readonly Finding[],
): RootCause[] {
  const known = new Set(sent.map((f) => f.id));
  const placed = new Set<string>();
  const causes: Array<Omit<RootCause, "fixOrder"> & { order: number }> = [];
  for (const c of [...output.causes].sort((a, b) => a.fixOrder - b.fixOrder)) {
    const ids = c.findingIds.filter((id) => known.has(id) && !placed.has(id));
    if (ids.length === 0) continue;
    for (const id of ids) placed.add(id);
    causes.push({ title: c.title, summary: c.summary, findingIds: ids, order: c.fixOrder });
  }
  for (const f of sent) {
    if (placed.has(f.id)) continue;
    causes.push({ title: f.title, summary: "", findingIds: [f.id], order: Infinity });
  }
  for (const f of all) {
    if (f.duplicateOf === undefined) continue;
    const cause = causes.find((c) => c.findingIds.includes(f.duplicateOf as string));
    if (cause && !cause.findingIds.includes(f.id)) cause.findingIds.push(f.id);
  }
  return causes.map(({ order: _order, ...c }, i) => ({ ...c, fixOrder: i + 1 }));
}
