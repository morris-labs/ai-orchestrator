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
// 3. The pull request description (`release/pull-request.md`): the Scribe's
//    text, with the criteria, the owner checks, and the known failing and
//    flaky tests that the engine adds.
// 4. The push answer in the build plan. Without one, the build stops at an
//    escalation for the owner. With `false`, the branch stays local.
// 5. The push and CI loop: the build's review run pushes the build branch,
//    opens the pull request, and fixes failing checks with the Developer
//    seat. It never pushes the default branch and never merges.
//
// The build then ends release ready, with a digest for the Project manager
// in `digests/release-ready.md`.
import { readdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  BuildCriterion,
  Escalation,
  EscalationResolve,
  RunState,
  StopReason,
} from "@aio/contracts";
import { RunCancelled, describeError } from "../../calls/index.js";
import { runGateCommand } from "../../gate/gate.js";
import { untrusted } from "../../prompts/templates.js";
import { loadBaseline, type TestBaseline } from "../baseline.js";
import type { BuildContext, ReviewRuns } from "../context.js";
import { escalationForCallError } from "../escalations.js";
import { outsideWritable } from "../gate.js";
import type { ListedTest } from "../red-check.js";
import { writablePaths, type RoleTask } from "../roles/index.js";
import { readTestLock } from "../test-lock.js";
import { REVIEW_POLL_MS, reopenRun } from "./review.js";
import type { StepOutcome } from "./types.js";

/** The seat that writes the record. */
export const SCRIBE = "scribe";

/** The release ready files, relative to the build directory. */
export const RELEASE_FILES = {
  trace: "release/trace.json",
  scribe: "release/scribe.json",
  pullRequest: "release/pull-request.md",
  push: "release/push.json",
  digest: "digests/release-ready.md",
} as const;

/** The review run stop reasons that report the diff clean, before its push. */
const CLEAN: readonly StopReason[] = ["clean", "clean_above_floor"];

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
 * and runs each of those tests' commands once in the worktree.
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
        const run = await runGateCommand(
          "test",
          { command: test.command },
          { repoPath: ctx.worktree.path, shell: ctx.services.shell, signal: ctx.signal },
        );
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

function knownFailingLines(baseline: TestBaseline): string[] {
  return baseline.knownFailing.flatMap((entry) =>
    entry.failures.map((failure) => `\`${entry.command}\`: ${failure}`),
  );
}

function flakyLines(baseline: TestBaseline): string[] {
  return baseline.flaky.map((entry) => {
    const where =
      entry.source.at === "preflight"
        ? "at preflight"
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
  const known = knownFailingLines(baseline);
  const flaky = flakyLines(baseline);
  return [
    `The build's decision files, in ${ctx.store.dir}: ${decisions.length > 0 ? decisions.join(", ") : "none"}.`,
    `Owner checks: ${owner.length > 0 ? owner.map((c) => c.id).join(", ") : "none"}.`,
    `Known failing tests: ${known.length}. Flaky tests: ${flaky.length}.`,
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

function bullets(lines: readonly string[], none: string): string[] {
  return lines.length === 0 ? [none] : lines.map((line) => `- ${line}`);
}

/** The pull request description: the Scribe's text and the engine's lists. */
export function pullRequestBody(
  ctx: BuildContext,
  scribe: DoneScribe,
  trace: TraceRecord,
  baseline: TestBaseline,
): string {
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
    ...bullets(knownFailingLines(baseline), "None."),
    "",
    "## Flaky tests",
    "",
    "These tests gave different results between runs of the same code, so the build quarantined them.",
    "",
    ...bullets(flakyLines(baseline), "None."),
    "",
    `Built by AI Orchestrator build \`${ctx.state.slug}\` on the branch \`${ctx.state.branch}\`.`,
    "",
  ].join("\n");
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
  return run.status === "finished" && run.stopReason !== null && CLEAN.includes(run.stopReason);
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
  const review = await ctx.store.readJson<{ runId: string }>(ctx.store.path("review", "run.json"));
  const run = review && runs ? await runs.get(review.runId) : null;
  if (!runs || !review || !run) {
    await ctx.escalate({
      kind: "release_ready",
      level: "project_manager",
      taskId: null,
      summary: "The build has no review run to push its branch with.",
      details: `Review record: ${review ? review.runId : "none"}. The push and CI loop runs in the build's review run.`,
    });
    return null;
  }
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
  push: PushRecord | null,
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
    `- Known failing tests: ${baseline.knownFailing.reduce((n, e) => n + e.failures.length, 0)}. Flaky tests: ${baseline.flaky.length}.`,
    `- Record: ${scribe.commit ? `commit \`${scribe.commit.slice(0, 12)}\`` : "no record changes"}.`,
    `- Pull request title: ${scribe.title}`,
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
  const baseline = await loadBaseline(ctx.store);
  let scribe: DoneScribe;
  try {
    scribe = await runScribe(ctx, baseline);
  } catch (error) {
    const draft = escalationForCallError(error, null);
    if (!draft) throw error;
    await ctx.escalate(draft);
    return "wait";
  }
  const body = pullRequestBody(ctx, scribe, trace, baseline);
  await ctx.store.writeText(ctx.store.path(RELEASE_FILES.pullRequest), body);
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
  await ctx.store.writeText(
    ctx.store.path(RELEASE_FILES.digest),
    digest(ctx, scribe, trace, baseline, push),
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
  return reopenRun(ctx, escalation, request, () => "keep");
}
