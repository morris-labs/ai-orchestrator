// The stage bodies that the pre-push and post-push drivers share. Each step
// reads its inputs from the run context, writes its output file to the run
// directory, and emits handoff events with counts.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  FileGroup,
  Finding,
  FindingOrigin,
  Hunk,
  RoundSummary,
  Stage,
  Vendor,
  VendorFinding,
  VendorRoundStats,
} from "@agentbox/contracts";
import type { ConfirmOutput, FixOutput, ReviewOutput, SweepOutput, VerifyOutput } from "../core.js";
import { compareGate, formatRegressions, runGate, type GateRun } from "../gate/gate.js";
import { groupFiles } from "../group/group.js";
import {
  hunksForFinding,
  missingHunks,
  newLedger,
  recordVerdicts,
  type GroupLedger,
} from "../ledger/ledger.js";
import { enclosingSymbol, fingerprint } from "../merge/fingerprint.js";
import { findingsLog, mergeCandidates, type Candidate, type MergeResult } from "../merge/merge.js";
import { policyPromptSection } from "../policy/rules.js";
import {
  confirmerPrompt,
  continuationPrompt,
  finderPrompt,
  fixerPrompt,
  ledgerFollowUpPrompt,
  sweepPrompt,
} from "../prompts/templates.js";
import { parseDiff } from "../range/diff.js";
import {
  BaseWorktree,
  chooseDisprover,
  verifyFinding,
  type VerifyResult,
} from "../verify/verify.js";
import { DecisionNeeded, type RunContext } from "./context.js";
import { planReviews, type ReviewTask } from "./profiles.js";

/** Ledger follow-ups per reviewer before the engine accepts missing verdicts. */
export const LEDGER_FOLLOW_UPS = 2;
/** Fix attempts in one round before a gate regression needs a person. */
export const GATE_ATTEMPTS = 3;
/** Parallel disprover calls. */
const VERIFY_CONCURRENCY = 4;

const SEVERITY_ABOVE_NIT = new Set(["P1", "P2", "P3"]);

export function aboveNit(f: Pick<Finding, "severity">): boolean {
  return SEVERITY_ABOVE_NIT.has(f.severity);
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
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

/** The tip the diff ends at: the tip SHA, or the working tree with `includeWorktree`. */
function diffTip(ctx: RunContext): string | null {
  return ctx.state.request.includeWorktree && ctx.round <= 1 ? null : (ctx.state.tipSha ?? "HEAD");
}

/** Computes the file groups for the current tip. */
export async function computeGroups(ctx: RunContext): Promise<FileGroup[]> {
  const diffBase = ctx.eng.diffBaseSha ?? ctx.state.baseSha ?? "";
  const text = await ctx.git.diff(diffBase, diffTip(ctx));
  const files = parseDiff(text);
  const tip = diffTip(ctx);
  return groupFiles(files, {
    policy: ctx.policy,
    readFile: (path) => (tip === null ? readWorkingFile(ctx, path) : ctx.git.show(tip, path)),
  });
}

async function readWorkingFile(ctx: RunContext, path: string): Promise<string | null> {
  try {
    return await readFile(join(ctx.state.request.repoPath, path), "utf8");
  } catch {
    return null;
  }
}

/** Reads a file at the current tip, with a per-call cache. */
function tipReader(ctx: RunContext): (path: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  const tip = diffTip(ctx);
  return (path) => {
    let p = cache.get(path);
    if (!p) {
      p = tip === null ? readWorkingFile(ctx, path) : ctx.git.show(tip, path);
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
  const diffBase = ctx.eng.diffBaseSha ?? ctx.state.baseSha ?? "";
  const diff = await ctx.git.diffForPrompt(diffBase, diffTip(ctx), files);
  const prompt = finderPrompt({
    range: ctx.range(),
    round: ctx.round,
    groupId: task.groupId,
    files,
    hunks,
    diff,
    focusAreas: task.focusAreas,
    findingsLog: findingsLog(ctx.findings),
    policySection: policyPromptSection(ctx.policy, files),
  });
  const base = {
    role: "reviewer" as const,
    groupId: task.groupId,
    allowFallback: true,
  };
  const first = await ctx.callAgent<ReviewOutput>({
    ...base,
    key: `find-${task.key}`,
    vendor: task.vendor,
    method: "review",
    request: { prompt, repoPath: ctx.state.request.repoPath, toolPolicy: "read-only" },
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
    for (let i = 0; i < LEDGER_FOLLOW_UPS; i++) {
      const missing = missingHunks(ledger, hunks);
      if (missing.length === 0) break;
      const followUp = ledgerFollowUpPrompt(missing);
      const out = await ctx.callAgent<ReviewOutput>({
        ...base,
        key: `find-${task.key}-ledger${i + 1}`,
        vendor,
        method: "continueReview",
        request: {
          prompt: followUp,
          repoPath: ctx.state.request.repoPath,
          toolPolicy: "read-only",
          sessionId,
        },
        estimateTokens: estimateTokens(followUp) + 2000,
        allowFallback: false,
      });
      calls += 1;
      absorb(out.output);
    }
    for (let i = 0; i < ctx.state.request.continuationCap; i++) {
      const more = continuationPrompt({ reported: collected.map((f) => f.title) });
      const out = await ctx.callAgent<ReviewOutput>({
        ...base,
        key: `find-${task.key}-more${i + 1}`,
        vendor,
        method: "continueReview",
        request: {
          prompt: more,
          repoPath: ctx.state.request.repoPath,
          toolPolicy: "read-only",
          sessionId,
        },
        estimateTokens: estimateTokens(more) + 2000,
        allowFallback: false,
      });
      calls += 1;
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
  const tasks = planReviews(ctx.state.roles.reviewer, groups, ctx.state.profile);
  const results = await Promise.all(tasks.map((t) => runReviewTask(ctx, t, groups)));
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
    const symbol = enclosingSymbol(content, r.finding.lines[0]);
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

/** Merges candidates into the run's findings and announces the new ones. */
export async function mergeInto(
  ctx: RunContext,
  candidates: readonly Candidate[],
): Promise<MergeResult> {
  const result = mergeCandidates(
    ctx.findings,
    candidates,
    {
      runId: ctx.state.id,
      round: Math.max(1, ctx.round),
      nextId: () => ctx.nextFindingId(),
      acceptedOscillations: ctx.eng.acceptedOscillations,
      now: () => ctx.nowIso(),
    },
    await symbolsOfFixed(ctx),
  );
  ctx.findings = result.findings;
  await ctx.persist();
  for (const id of result.created) {
    const f = ctx.findingById(id);
    if (f) await ctx.announceFinding(f);
  }
  return result;
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
  const candidates = await toCandidates(ctx, raw, "reviewer", groups);
  const result = await mergeInto(ctx, candidates);
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

const baseWorktrees = new WeakMap<RunContext, BaseWorktree>();

export function baseWorktreeFor(ctx: RunContext): BaseWorktree {
  let wt = baseWorktrees.get(ctx);
  if (!wt) {
    wt = new BaseWorktree(ctx.git, ctx.state.baseSha ?? "HEAD");
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

/** Verifies every pending finding with a disprover from another vendor. */
export async function verifyPending(ctx: RunContext, stageFile: string): Promise<VerifyResult[]> {
  const pending = ctx.findings.filter((f) => f.verdict === "pending");
  const results = await mapLimit(pending, VERIFY_CONCURRENCY, async (finding) => {
    const vendor = chooseDisprover(reporterVendor(finding), ctx.state.roles, {
      crossVendor: ctx.state.request.crossVendor,
      available: ctx.availableVendors,
      profile: ctx.state.profile,
    });
    const result = await verifyFinding(finding, vendor, {
      runner: ctx.deps.runner,
      range: ctx.range(),
      policy: ctx.policy,
      baseWorktree: baseWorktreeFor(ctx),
      scratchDirFor: (id) => ctx.store.scratchDir(id),
      timeoutMs: ctx.timeouts.disprover,
      callDisprover: async (v, f, request) => {
        const out = await ctx.callAgent<VerifyOutput>({
          key: `verify-${f.id}`,
          role: "disprover",
          vendor: v,
          method: "verify",
          request,
          groupId: f.groupId,
          estimateTokens: estimateTokens(request.prompt) + 6000,
          allowFallback: true,
        });
        return { vendor: out.vendor, model: out.model, output: out.output };
      },
    });
    if (result) {
      const d = result.decision;
      await ctx.setVerdict(
        finding,
        d.verdict,
        { kind: "agent", vendor: result.vendor, model: result.model, role: "disprover" },
        d.evidence,
        { verification: d.verification, introduced: d.introduced },
      );
    }
    return result;
  });
  const done = results.filter((r): r is VerifyResult => r !== null);
  await ctx.store.writeJson(stageFile, done);
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

// ---------------------------------------------------------------------------
// Sweep

/** The pattern sweep: confirmed findings of this round become patterns. Returns created finding ids. */
export async function runSweep(
  ctx: RunContext,
  groups: readonly FileGroup[],
): Promise<MergeOutput | null> {
  const file = ctx.store.roundFile(ctx.round, "sweep");
  const saved = await ctx.store.readJson<MergeOutput>(file);
  if (saved) return saved;
  const patterns = ctx.findings.filter(
    (f) =>
      f.verdict === "confirmed" &&
      f.history.some((h) => h.verdict === "confirmed" && h.round === ctx.round),
  );
  if (patterns.length === 0) {
    await ctx.store.writeJson(file, null);
    return null;
  }
  const vendor =
    ctx.state.roles.reviewer.find((v) => v !== "claude") ?? ctx.state.roles.reviewer[0] ?? "codex";
  const diffBase = ctx.eng.diffBaseSha ?? ctx.state.baseSha ?? "";
  const diff = await ctx.git.diffForPrompt(diffBase, diffTip(ctx));
  const prompt = sweepPrompt({
    range: ctx.range(),
    patterns,
    diff,
    policySection: policyPromptSection(ctx.policy),
  });
  const out = await ctx.callAgent<SweepOutput>({
    key: "sweep",
    role: "sweeper",
    vendor,
    method: "sweep",
    request: { prompt, repoPath: ctx.state.request.repoPath, toolPolicy: "read-only" },
    groupId: null,
    estimateTokens: estimateTokens(prompt) + 3000,
    allowFallback: true,
  });
  const raw = out.output.findings.map((finding) => ({
    finding,
    vendor: out.vendor,
    model: out.model,
    groupId: null,
  }));
  const candidates = await toCandidates(ctx, raw, "sweep", groups);
  const result = await mergeInto(ctx, candidates);
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

export interface FixRecord {
  attempt: number;
  preFixSha: string;
  batches: Array<{
    findingIds: string[];
    before: string;
    after: string;
    commits: string[];
    output: FixOutput;
  }>;
}

/** Findings the fixer should work on: confirmed, above `nit`, and not declined twice. */
export function fixTargets(ctx: RunContext): Finding[] {
  const declined = new Set(ctx.eng.declined);
  return ctx.findings.filter(
    (f) => f.verdict === "confirmed" && aboveNit(f) && !declined.has(f.id),
  );
}

/** The fix stage: the fixer fixes confirmed findings in batches per group and commits. */
export async function runFix(
  ctx: RunContext,
  targets: readonly Finding[],
  gateFailure?: string,
): Promise<FixRecord> {
  const attempt = ctx.eng.gateAttempts + 1;
  const file = ctx.store.roundFile(ctx.round, `fix-${attempt}`);
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

  // On a gate retry, one batch carries every target and the failure report.
  const batches: Finding[][] = [];
  if (gateFailure) batches.push([...targets]);
  else {
    const byGroup = new Map<string, Finding[]>();
    for (const f of targets) {
      const k = f.groupId ?? "none";
      byGroup.set(k, [...(byGroup.get(k) ?? []), f]);
    }
    for (const k of [...byGroup.keys()].sort()) batches.push(byGroup.get(k) ?? []);
  }

  const record: FixRecord = { attempt, preFixSha, batches: [] };
  for (const [index, batch] of batches.entries()) {
    const before = await ctx.git.head();
    const prompt = fixerPrompt({
      range: ctx.range(),
      findings: batch,
      gateFailure,
      policySection: policyPromptSection(
        ctx.policy,
        batch.flatMap((f) => (f.file ? [f.file] : [])),
      ),
    });
    const out = await ctx.callAgent<FixOutput>({
      key: `fix-${attempt}-${index + 1}`,
      role: "fixer",
      vendor: ctx.state.roles.fixer,
      method: "fix",
      request: { prompt, repoPath: ctx.state.request.repoPath, toolPolicy: "write" },
      groupId: batch[0]?.groupId ?? null,
      estimateTokens: estimateTokens(prompt) + 8000,
      allowFallback: false,
    });
    const after = await ctx.git.head();
    if (!(await ctx.git.ok(["merge-base", "--is-ancestor", before, after]))) {
      throw new Error(
        `The fixer rewrote history on ${branch}: ${before} is no longer an ancestor of ${after}.`,
      );
    }
    const commits = after === before ? [] : await ctx.git.commitsBetween(before, after);
    record.batches.push({
      findingIds: batch.map((f) => f.id),
      before,
      after,
      commits,
      output: out.output,
    });
    const fixedIds = new Set(out.output.fixed);
    for (const f of batch) {
      const finding = ctx.findingById(f.id);
      if (!finding) continue;
      if (fixedIds.has(f.id) && commits.length > 0) finding.fixCommit = after;
    }
    for (const nf of out.output.notFixed) {
      ctx.eng.declined = [...new Set([...ctx.eng.declined, nf.id])];
    }
    ctx.state.tipSha = after;
    await ctx.persist();
  }
  await ctx.store.writeJson(file, record);
  const fixed = targets.filter((f) => ctx.findingById(f.id)?.fixCommit).length;
  await ctx.handoff(
    { stage: "fix", vendor: ctx.state.roles.fixer, role: "fixer" },
    { stage: "gate" },
    "fixes",
    fixed,
    file,
  );
  return record;
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
  const file = ctx.store.roundFile(ctx.round, `gate-${attempt}`);
  const saved = await ctx.store.readJson<GateRecord>(file);
  if (saved) return saved;
  const baseline = (await ctx.store.readJson<{ baseline: GateRun }>("preflight.json"))
    ?.baseline ?? { passed: true, commands: [] };
  const run = await runGate(ctx.policy, {
    repoPath: ctx.state.request.repoPath,
    shell: ctx.shell,
    signal: ctx.signal,
  });
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

/** The confirm stage: a reviewer from another vendor checks the fix diff. */
export async function runConfirm(
  ctx: RunContext,
  groups: readonly FileGroup[],
): Promise<ConfirmRecord> {
  const file = ctx.store.roundFile(ctx.round, "confirm");
  const saved = await ctx.store.readJson<ConfirmRecord>(file);
  if (saved) return saved;
  const fixed = ctx.findings.filter((f) => f.verdict === "confirmed" && f.fixCommit);
  const preFixSha = ctx.eng.preFixSha;
  if (fixed.length === 0 || !preFixSha) {
    const empty: ConfirmRecord = { confirmer: null, fixedIds: [], incomplete: [], created: [] };
    await ctx.store.writeJson(file, empty);
    return empty;
  }
  const head = await ctx.git.head();
  const fixDiff = await ctx.git.diffForPrompt(preFixSha, head);
  const prompt = confirmerPrompt({
    range: ctx.range(),
    findings: fixed,
    fixDiff,
    policySection: policyPromptSection(ctx.policy),
  });
  const vendor = ctx.state.request.crossVendor ? ctx.state.roles.confirmer : ctx.state.roles.fixer;
  const out = await ctx.callAgent<ConfirmOutput>({
    key: "confirm",
    role: "confirmer",
    vendor,
    method: "confirm",
    request: { prompt, repoPath: ctx.state.request.repoPath, toolPolicy: "read-only" },
    groupId: null,
    estimateTokens: estimateTokens(prompt) + 3000,
    allowFallback: true,
  });
  const actor = { kind: "agent" as const, vendor: out.vendor, model: out.model, role: "confirmer" };
  const incomplete = new Map(out.output.incomplete.map((i) => [i.id, i.reason]));
  const fixedIds: string[] = [];
  for (const f of fixed) {
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
  const candidates = await toCandidates(ctx, raw, "confirmer", groups);
  const merged = await mergeInto(ctx, candidates);
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
      f.history.some(
        (h) => h.round === ctx.round && h.verdict === "confirmed" && h.actor.role === "disprover",
      ),
  );
}

export { computeGroups as regroup };
