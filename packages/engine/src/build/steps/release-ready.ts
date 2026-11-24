// The release ready step: the last step of a build, after the review run
// reported the diff clean. It runs these parts in order, and each saves its
// result in the build's `release/` directory before the next one starts, so
// a restarted engine continues from the last finished part:
//
// 1. The criteria trace (`release/trace.json`): every test and UI check
//    criterion needs a locked test, which passed the red check, that passes
//    in the worktree.
// 2. The Scribe (`release/scribe.json`): the decision records, the glossary
//    entries, and the changelog entry, committed on the build branch, and the
//    pull request's title and description.
// 3. The final gate (`release/gate.json`, saved only when it passes): the
//    plan's full test, type check, and lint commands, on the build branch
//    with the Scribe's record. Known failing and flaky tests from the
//    baseline don't fail it.
// 4. The pull request description (`release/pull-request.md`): the Scribe's
//    text, with the criteria, the owner checks, the known failing tests that
//    still fail, the known failing tests that the build fixed, and the flaky
//    tests, which the engine adds.
// 5. The push answer in the build plan. Without one, the build stops at an
//    escalation for the owner. With `false`, the branch stays local.
// 6. The push and CI loop: the build's review run pushes the build branch,
//    opens the pull request, and fixes failing checks with the Developer
//    seat. It never pushes the default branch and never merges. A retry
//    after the loop ended without a clean pull request, or was cancelled,
//    sets the run aside and starts a new one, which reviews the diff again
//    before it pushes.
//
// The build then ends release ready, with a digest for the Project manager
// in `digests/release-ready.md`.
import { readFile, readdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  BuildCriterion,
  Escalation,
  EscalationResolve,
  Finding,
  RunState,
  StopReason,
} from "@aio/contracts";
import { RunCancelled, describeError } from "../../calls/index.js";
import { runGateCommand, type GateCommandResult } from "../../gate/gate.js";
import { untrusted } from "../../prompts/templates.js";
import {
  commandKey,
  loadBaseline,
  quarantine,
  testFailures,
  type BaselineTests,
  type TestBaseline,
} from "../baseline.js";
import type { BuildContext, ReviewRuns } from "../context.js";
import { escalationForCallError } from "../escalations.js";
import { gateReport, outsideWritable, runTaskGate, type TaskGateResult } from "../gate.js";
import type { ListedTest } from "../red-check.js";
import { runListedTest } from "../test-command.js";
import { writablePaths, type RoleTask } from "../roles/index.js";
import { readTestLock } from "../test-lock.js";
import { reportProjectManagerUsage, type TranscriptUsage } from "../pm-usage.js";
import { CLEAN_REVIEW, REVIEW_POLL_MS, ensureRun, reopenRun } from "./review.js";
import type { StepOutcome } from "./types.js";

/** The seat that writes the record. */
export const SCRIBE = "scribe";

/** The release ready files, relative to the build directory. */
export const RELEASE_FILES = {
  trace: "release/trace.json",
  scribe: "release/scribe.json",
  gate: "release/gate.json",
  pullRequest: "release/pull-request.md",
  push: "release/push.json",
  digest: "digests/release-ready.md",
} as const;

/** One criterion in the trace. */
export interface TracedCriterion {
  id: string;
  verification: BuildCriterion["verification"];
  /** The locked tests that name the criterion, each with whether it passed. */
  tests: Array<ListedTest & { passed: boolean }>;
  /** True when at least one of its tests passed. */
  passed: boolean;
}

/** The criteria trace, as `release/trace.json` saves it. */
export interface TraceRecord {
  passed: boolean;
  criteria: TracedCriterion[];
}

/** The Scribe's part, as `release/scribe.json` saves it. */
export interface ScribeRecord {
  /** The worktree's `HEAD` before the Scribe started. */
  start: string;
  callKey: string;
  answer?: { vendor: string; model: string; output: Record<string, unknown> };
  /** Changed files outside the Scribe's paths, which the engine put back. */
  outside?: string[];
  /** The record commit, or `null` when the Scribe changed nothing. */
  commit?: string | null;
  title?: string;
  body?: string;
}

type DoneScribe = ScribeRecord & { commit: string | null; title: string; body: string };

/** The final gate's outcome, as `release/gate.json` saves it. */
export interface FinalGateRecord {
  passed: true;
  /** The test failure lines that the final gate's runs still showed, by command. */
  failing: BaselineTests[];
}

/** The push and CI loop's outcome, as `release/push.json` saves it. */
export interface PushRecord {
  runId: string;
  prNumber: number | null;
  prUrl: string | null;
  stopReason: StopReason | null;
}

/** The criteria that a test or a UI check verifies. */
function checkedCriteria(ctx: BuildContext): BuildCriterion[] {
  return ctx.plan.criteria.filter((c) => c.verification === "test" || c.verification === "ui");
}

/**
 * Traces each test and UI check criterion to the locked tests that name it,
 * and runs each of those tests' commands once in the worktree with
 * `runListedTest()`: a run of no tests doesn't count as a pass.
 */
async function traceCriteria(ctx: BuildContext): Promise<TraceRecord> {
  const lock = await readTestLock(ctx.store);
  const locked = lock?.tests ?? [];
  const before = new Set(await ctx.worktree.untracked());
  const results = new Map<string, boolean>();
  const criteria: TracedCriterion[] = [];
  for (const criterion of checkedCriteria(ctx)) {
    const tests: TracedCriterion["tests"] = [];
    for (const test of locked.filter((t) => t.criterion === criterion.id)) {
      let passed = results.get(test.command);
      if (passed === undefined) {
        const run = await runListedTest(test.command, ctx.plan.commands, {
          repoPath: ctx.worktree.path,
          shell: ctx.services.shell,
          signal: ctx.signal,
        });
        passed = run.passed;
        results.set(test.command, passed);
      }
      tests.push({ ...test, passed });
    }
    criteria.push({
      id: criterion.id,
      verification: criterion.verification,
      tests,
      passed: tests.some((t) => t.passed),
    });
  }
  const leftovers = (await ctx.worktree.untracked()).filter((path) => !before.has(path));
  await ctx.worktree.remove(leftovers);
  return { passed: criteria.every((c) => c.passed), criteria };
}

function traceLine(c: TracedCriterion): string {
  if (c.tests.length === 0) {
    return `- ${c.id} (${c.verification}): no locked test names this criterion, so nothing shows that it holds.`;
  }
  const tests = c.tests.map((t) => `"${t.name}" in ${t.file} ${t.passed ? "passes" : "fails"}`);
  return `- ${c.id} (${c.verification}): ${tests.join("; ")}.`;
}

function scribeTask(ctx: BuildContext, ownedFiles: string[], context: string): RoleTask {
  return {
    id: "release",
    title: `Release record for ${ctx.plan.title}`,
    description:
      "Write the record of this build before its pull request: decision records, glossary entries, and a changelog entry, then the pull request's title and description.",
    repoPath: ctx.worktree.path,
    branch: ctx.state.branch,
    ownedFiles,
    criteria: ctx.plan.criteria.map((c) => ({ id: c.id, text: `${c.text} (${c.verification})` })),
    context,
  };
}

async function decisionFiles(ctx: BuildContext): Promise<string[]> {
  try {
    return (await readdir(ctx.store.path("decisions"))).sort().map((name) => `decisions/${name}`);
  } catch {
    return [];
  }
}

/** The owner checks of the plan: manual items for the pull request's checklist. */
function ownerChecks(ctx: BuildContext): BuildCriterion[] {
  return ctx.plan.criteria.filter((c) => c.verification === "owner");
}

/**
 * The baseline's known failing tests as lines: with `fixed: false`, the ones
 * that still failed in the final gate, and with `fixed: true`, the ones that
 * the build made pass.
 */
function knownFailingLines(baseline: TestBaseline, gate: FinalGateRecord, fixed = false): string[] {
  const failing = new Set(
    gate.failing.flatMap((e) => e.failures.map((f) => `${commandKey(e)}\0${f}`)),
  );
  return baseline.knownFailing.flatMap((entry) =>
    entry.failures
      .filter((failure) => failing.has(`${commandKey(entry)}\0${failure}`) !== fixed)
      .map((failure) => `\`${entry.command}\`: ${failure}`),
  );
}

function flakyLines(baseline: TestBaseline): string[] {
  return baseline.flaky.map((entry) => {
    const where =
      entry.source.at === "preflight"
        ? "at preflight"
        : entry.source.at === "release"
          ? "in the final gate before release"
          : `in the task gate of ${entry.source.taskId}, attempt ${entry.source.attempt}`;
    return `\`${entry.command}\`: ${entry.failure} (found ${where})`;
  });
}

async function scribeContext(ctx: BuildContext, baseline: TestBaseline): Promise<string> {
  const git = ctx.worktree.git;
  const commits = await git.run(["log", "--format=%h %s", `${ctx.state.base}..HEAD`]);
  const changed = await git.run(["diff", "--stat", ctx.state.base, "HEAD"]);
  const decisions = await decisionFiles(ctx);
  const owner = ownerChecks(ctx);
  const known = baseline.knownFailing.reduce((n, e) => n + e.failures.length, 0);
  const flaky = flakyLines(baseline);
  return [
    `The build's decision files, in ${ctx.store.dir}: ${decisions.length > 0 ? decisions.join(", ") : "none"}.`,
    `Owner checks: ${owner.length > 0 ? owner.map((c) => c.id).join(", ") : "none"}.`,
    `Known failing tests at the build's base: ${known}. Flaky tests: ${flaky.length}. The engine lists them in the pull request.`,
    "",
    "The build's commits and changed files:",
    "",
    untrusted(`${commits.trim()}\n\n${changed.trim()}`),
  ].join("\n");
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Runs the Scribe, or returns its saved part when it already finished. */
async function runScribe(ctx: BuildContext, baseline: TestBaseline): Promise<DoneScribe> {
  const path = ctx.store.path(RELEASE_FILES.scribe);
  let record = await ctx.store.readJson<ScribeRecord>(path);
  if (record?.commit !== undefined && record.title && record.body !== undefined) {
    return record as DoneScribe;
  }
  if (!record) {
    record = { start: await ctx.worktree.head(), callKey: "release-scribe" };
    await ctx.store.writeJson(path, record);
  }
  const role = ctx.role(SCRIBE);
  const paths = writablePaths(role, scribeTask(ctx, [], ""));
  const outcome = await ctx.callSeat({
    seat: SCRIBE,
    key: record.callKey,
    step: "release_ready",
    task: scribeTask(ctx, paths, await scribeContext(ctx, baseline)),
  });
  record.answer = { vendor: outcome.vendor, model: outcome.model, output: outcome.output };
  await ctx.store.writeJson(path, record);
  await ctx.calls.checkpoint();
  const outside = outsideWritable(await ctx.worktree.changedSince(record.start), paths);
  if (outside.length > 0) await ctx.worktree.restorePaths(record.start, outside);
  const commit = (await ctx.worktree.dirty())
    ? await ctx.worktree.commitAll(`docs: record ${ctx.plan.title}`)
    : null;
  const pr =
    typeof outcome.output.pullRequest === "object" && outcome.output.pullRequest !== null
      ? (outcome.output.pullRequest as Record<string, unknown>)
      : {};
  const done: DoneScribe = {
    ...record,
    outside,
    commit,
    title: text(pr.title) ?? ctx.plan.title,
    body: text(pr.body) ?? text(outcome.output.summary) ?? "",
  };
  await ctx.store.writeJson(path, done);
  return done;
}

/**
 * The build's review run findings that wait for a person: no vendor would
 * check them, so the run ended clean with follow-ups.
 */
async function reviewFollowUps(ctx: BuildContext): Promise<Finding[]> {
  const runs = ctx.services.reviews;
  const review = await ctx.store.readJson<{ runId: string }>(ctx.store.path("review", "run.json"));
  if (!runs || !review || !(await runs.get(review.runId))) return [];
  const pending = await runs.findings(review.runId, { verdict: "pending" });
  return pending.filter((f) => f.followUpReason !== undefined);
}

function followUpLine(f: Finding): string {
  const where = f.file ? ` \`${f.file}${f.lines ? `:${f.lines[0]}-${f.lines[1]}` : ""}\`` : "";
  return `- [ ] ${f.id} (${f.severity})${where}: ${f.title}. No vendor checked it: ${f.followUpReason ?? ""}`;
}

function bullets(lines: readonly string[], none: string): string[] {
  return lines.length === 0 ? [none] : lines.map((line) => `- ${line}`);
}

/** The pull request description: the Scribe's text and the engine's lists. */
export function pullRequestBody(
  ctx: BuildContext,
  scribe: DoneScribe,
  trace: TraceRecord,
  baseline: TestBaseline,
  gate: FinalGateRecord,
  followUps: readonly Finding[],
): string {
  const fixed = knownFailingLines(baseline, gate, true);
  const texts = new Map(ctx.plan.criteria.map((c) => [c.id, c.text]));
  const traced = trace.criteria.map((c) => {
    const passing = c.tests.filter((t) => t.passed).map((t) => `\`${t.file}\` "${t.name}"`);
    return `${c.id}: ${texts.get(c.id) ?? ""} Verified by ${passing.join(", ")}.`;
  });
  return [
    scribe.body,
    "",
    "## Acceptance criteria",
    "",
    ...bullets(traced, "No criterion has an automated check."),
    "",
    "## Owner checks",
    "",
    ...(ownerChecks(ctx).length === 0
      ? ["None."]
      : ownerChecks(ctx).map((c) => `- [ ] ${c.id}: ${c.text}`)),
    "",
    "## Known failing tests",
    "",
    "These tests failed in every preflight run at the build's base, so the build doesn't count them as regressions.",
    "",
    ...bullets(knownFailingLines(baseline, gate), "None."),
    "",
    "## Flaky tests",
    "",
    "These tests gave different results between runs of the same code, so the build quarantined them.",
    "",
    ...bullets(flakyLines(baseline), "None."),
    "",
    ...(followUps.length === 0
      ? []
      : [
          "## Review follow-ups",
          "",
          "The review run reported these findings, and no vendor would check them. Check each one before you merge.",
          "",
          ...followUps.map(followUpLine),
          "",
        ]),
    ...(fixed.length === 0
      ? []
      : [
          "## Fixed tests",
          "",
          "These tests failed in every preflight run at the build's base, and they pass on the build branch.",
          "",
          ...bullets(fixed, "None."),
          "",
        ]),
    `Built by AI Orchestrator build \`${ctx.state.slug}\` on the branch \`${ctx.state.branch}\`.`,
    "",
  ].join("\n");
}

/** The test failure lines of a run, also when the gate excused them and counts it as passed. */
function failedLines(run: GateCommandResult): string[] {
  return testFailures({ ...run, passed: run.exitCode === 0 && !run.timedOut });
}

/** The failure lines that a test command's runs in the final gate showed, first run and rerun. */
function stillFailing(result: TaskGateResult): BaselineTests[] {
  return result.commands
    .filter((c) => c.kind === "test")
    .map((c) => ({
      command: c.command,
      cwd: c.cwd,
      failures: [
        ...new Set([...failedLines(c), ...(c.firstRun ? failedLines(c.firstRun) : [])]),
      ].sort(),
    }))
    .filter((e) => e.failures.length > 0);
}

/**
 * Runs the final gate, or returns its saved record when it already passed.
 * Returns `null` when the gate failed and the step escalated.
 */
async function finalGate(ctx: BuildContext): Promise<FinalGateRecord | null> {
  const path = ctx.store.path(RELEASE_FILES.gate);
  const saved = await ctx.store.readJson<FinalGateRecord>(path);
  if (saved) return saved;
  const result = await runTaskGate({
    worktree: ctx.worktree,
    // Nothing changes in the final gate, so it checks no writable paths.
    base: await ctx.worktree.head(),
    writable: ["**"],
    commands: ctx.plan.commands,
    shell: ctx.services.shell,
    baseline: await loadBaseline(ctx.store),
    // The build exists to make its tasks' tests pass, so the baseline never excuses them.
    protect: ctx.plan.tasks.flatMap((t) => t.tests),
    signal: ctx.signal,
  });
  if (ctx.signal.aborted) throw new RunCancelled();
  await quarantine(
    ctx.store,
    (result.quarantined ?? []).map((t) => ({ ...t, source: { at: "release" as const } })),
  );
  if (!result.passed) {
    const failed = result.commands.filter((c) => !c.passed);
    await ctx.escalate({
      kind: "release_ready",
      level: "project_manager",
      taskId: null,
      summary: `The final gate before release failed: ${failed.map((c) => `${c.kind} \`${c.command}\``).join(", ")}.`,
      details: gateReport(result),
    });
    return null;
  }
  const record: FinalGateRecord = { passed: true, failing: stillFailing(result) };
  await ctx.store.writeJson(path, record);
  return record;
}

/** Waits until `done` holds for the run. */
async function waitForRun(
  ctx: BuildContext,
  runs: ReviewRuns,
  runId: string,
  done: (run: RunState) => boolean,
): Promise<RunState> {
  const pollMs = ctx.services.reviewPollMs ?? REVIEW_POLL_MS;
  for (;;) {
    const run = await runs.get(runId);
    if (!run) throw new Error(`The build's review run ${runId} is missing.`);
    if (done(run)) return run;
    try {
      await sleep(pollMs, undefined, { signal: ctx.signal });
    } catch {
      throw new RunCancelled();
    }
  }
}

/** True for a run that finished its pre-push rounds clean and hasn't pushed yet. */
function cleanBeforePush(run: RunState): boolean {
  return (
    run.status === "finished" && run.stopReason !== null && CLEAN_REVIEW.includes(run.stopReason)
  );
}

/** True for a run that stopped at a decision or ended, after its push started. */
function pushSettled(run: RunState): boolean {
  if (cleanBeforePush(run)) return false;
  return ["waiting_decision", "finished", "failed", "cancelled"].includes(run.status);
}

/** Why the push and CI loop didn't end with a clean pull request, as escalation details. */
function pushDetails(run: RunState): string {
  const lines = [
    `Review run: ${run.id}`,
    `Run files: .aio/runs/${run.id}/`,
    `Status: ${run.status}`,
    `Stop reason: ${run.stopReason ?? "none"}`,
    `Pull request: ${run.prUrl ?? "none"}`,
  ];
  if (run.decision) lines.push(`Decision: ${run.decision.kind}`, "", run.decision.message);
  if (run.error) lines.push("", `Error: ${run.error}`);
  return lines.join("\n");
}

/**
 * Pushes the build branch through the review run's post-push loop and waits
 * for it. Returns the record, or `null` when the step escalated.
 */
async function pushAndWatch(
  ctx: BuildContext,
  title: string,
  body: string,
): Promise<PushRecord | null> {
  const saved = await ctx.store.readJson<PushRecord>(ctx.store.path(RELEASE_FILES.push));
  if (saved) return saved;
  const runs = ctx.services.reviews;
  if (!runs) {
    await ctx.escalate({
      kind: "release_ready",
      level: "project_manager",
      taskId: null,
      summary: "This engine has no review runs to push the build's branch with.",
      details: "The push and CI loop runs in the build's review run.",
    });
    return null;
  }
  // The review step's run, or a new one after a retry set the ended one
  // aside, or after the run manager lost it. A new run reviews the diff
  // before it pushes.
  const runId = await ensureRun(ctx, runs, "release_ready");
  if (runId === null) return null;
  const run = await waitForRun(ctx, runs, runId, (r) => cleanBeforePush(r) || pushSettled(r));
  if (cleanBeforePush(run)) {
    try {
      await runs.push(run.id, { title, body, draft: false });
    } catch (error) {
      await ctx.escalate({
        kind: "release_ready",
        level: "project_manager",
        taskId: null,
        runId: run.id,
        summary: `The build's review run can't push: ${describeError(error)}`,
        details: pushDetails(run),
      });
      return null;
    }
  }
  const ended = await waitForRun(ctx, runs, run.id, pushSettled);
  if (ended.status !== "finished" || ended.stopReason !== "pr_clean") {
    await ctx.escalate({
      kind: "release_ready",
      level: "project_manager",
      taskId: null,
      runId: ended.id,
      summary:
        ended.status === "waiting_decision"
          ? `The push and CI loop needs a decision (${ended.decision?.kind ?? "unknown"}).`
          : `The push and CI loop ended without a clean pull request (${ended.stopReason ?? ended.status}).`,
      details: pushDetails(ended),
    });
    return null;
  }
  const record: PushRecord = {
    runId: ended.id,
    prNumber: ended.prNumber ?? null,
    prUrl: ended.prUrl ?? null,
    stopReason: ended.stopReason,
  };
  await ctx.store.writeJson(ctx.store.path(RELEASE_FILES.push), record);
  return record;
}

/** The digest for the Project manager. */
function digest(
  ctx: BuildContext,
  scribe: DoneScribe,
  trace: TraceRecord,
  baseline: TestBaseline,
  gate: FinalGateRecord,
  push: PushRecord | null,
  pm: TranscriptUsage | null,
): string {
  const owner = ownerChecks(ctx);
  return [
    `# Build ${ctx.state.slug} is release ready`,
    "",
    push
      ? `The build pushed \`${ctx.state.branch}\` and opened ${push.prUrl ?? `pull request #${push.prNumber ?? "?"}`}. Its checks pass. Nothing merges it: the owner reviews and merges.`
      : `The build plan says not to push, so \`${ctx.state.branch}\` stays local. The pull request description is in \`${RELEASE_FILES.pullRequest}\`.`,
    "",
    `- Criteria traced to passing tests: ${trace.criteria.map((c) => c.id).join(", ") || "none"}.`,
    `- Owner checks for the owner: ${owner.map((c) => c.id).join(", ") || "none"}.`,
    `- Known failing tests: ${knownFailingLines(baseline, gate).length}. Fixed tests: ${knownFailingLines(baseline, gate, true).length}. Flaky tests: ${baseline.flaky.length}.`,
    `- Record: ${scribe.commit ? `commit \`${scribe.commit.slice(0, 12)}\`` : "no record changes"}.`,
    `- Pull request title: ${scribe.title}`,
    ...(pm
      ? [
          `- Project manager session since planning started (tokens only): ${pm.turns} turns, ${pm.tokensIn} tokens in, ${pm.tokensOut} tokens out.`,
        ]
      : []),
    "",
  ].join("\n");
}

/** The release ready step. */
export async function runReleaseReady(ctx: BuildContext): Promise<StepOutcome> {
  let trace = await ctx.store.readJson<TraceRecord>(ctx.store.path(RELEASE_FILES.trace));
  if (!trace) {
    trace = await traceCriteria(ctx);
    if (ctx.signal.aborted) throw new RunCancelled();
    if (!trace.passed) {
      const failing = trace.criteria.filter((c) => !c.passed);
      await ctx.escalate({
        kind: "release_ready",
        level: "project_manager",
        taskId: null,
        summary: `No passing test shows that ${failing.map((c) => c.id).join(", ")} ${failing.length === 1 ? "holds" : "hold"}.`,
        details: ["Criteria trace:", ...trace.criteria.map(traceLine)].join("\n"),
      });
      return "wait";
    }
    await ctx.store.writeJson(ctx.store.path(RELEASE_FILES.trace), trace);
  }
  await ctx.calls.checkpoint();
  let scribe: DoneScribe;
  try {
    scribe = await runScribe(ctx, await loadBaseline(ctx.store));
  } catch (error) {
    const draft = escalationForCallError(error, null);
    if (!draft) throw error;
    await ctx.escalate(draft);
    return "wait";
  }
  await ctx.calls.checkpoint();
  const gate = await finalGate(ctx);
  if (!gate) return "wait";
  // The final gate can quarantine more flaky tests.
  const baseline = await loadBaseline(ctx.store);
  // A retry after a push run ended sets that run's record aside, and with
  // it the follow-ups, so the description written once stays.
  const bodyFile = ctx.store.path(RELEASE_FILES.pullRequest);
  const written = await readFile(bodyFile, "utf8").catch(() => null);
  const body =
    written ?? pullRequestBody(ctx, scribe, trace, baseline, gate, await reviewFollowUps(ctx));
  if (written === null) await ctx.store.writeText(bodyFile, body);
  await ctx.calls.checkpoint();
  let push: PushRecord | null = null;
  if (ctx.plan.push === null) {
    await ctx.escalate({
      kind: "release_ready",
      level: "owner",
      taskId: null,
      summary:
        "The build plan has no push answer. Ask the owner whether the build can push its branch and open its pull request.",
      details: `The branch ${ctx.state.branch} is ready, and the pull request description is in ${RELEASE_FILES.pullRequest}. Ask the owner, then resolve this escalation with the owner's push answer, which the build plan records.`,
    });
    return "wait";
  }
  if (ctx.plan.push) {
    push = await pushAndWatch(ctx, scribe.title, body);
    if (!push) return "wait";
  }
  const pm = await reportProjectManagerUsage(ctx);
  await ctx.store.writeText(
    ctx.store.path(RELEASE_FILES.digest),
    digest(ctx, scribe, trace, baseline, gate, push, pm),
  );
  ctx.state.note = `Release ready. The digest is in ${RELEASE_FILES.digest}.`;
  await ctx.persist();
  await ctx.toProjectManager({
    kind: "digest",
    ref: "release-ready",
    summary: push
      ? `Build ${ctx.state.slug} is release ready: its pull request's checks pass.`
      : `Build ${ctx.state.slug} is release ready: its branch stays local.`,
    file: RELEASE_FILES.digest,
    needsAnswer: false,
  });
  return "next";
}

/**
 * Prepares the release ready step to run again after its escalation was
 * resolved: answers or continues the build's review run when the escalation
 * names it. The step itself starts again from its last saved part.
 */
export function reopenReleaseReady(
  ctx: BuildContext,
  escalation: Escalation,
  request: EscalationResolve,
): Promise<void> {
  // A run that ended or was cancelled after its push can't push again, so
  // the step starts a new one. A clean run that couldn't push tries again.
  return reopenRun(ctx, escalation, request, (run) =>
    !cleanBeforePush(run) && (run.status === "finished" || run.status === "cancelled")
      ? "rerun"
      : "keep",
  );
}
