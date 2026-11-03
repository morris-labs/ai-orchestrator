// The post-push loop (design.md, "Post-push pipeline"): push, open or update
// the pull request, request a Copilot review, poll the review and the checks,
// import comments and failing checks as findings, verify, fix, gate, reply,
// resolve, and push again.
import {
  FindingInputSchema,
  READ_ONLY_POST_PUSH_MESSAGE,
  isReadOnlyPostPush,
  postPushRoundCap,
  type Finding,
  type Severity,
} from "@aio/contracts";
import { createHash } from "node:crypto";
import { DecisionNeeded, type RunContext } from "../state/context.js";
import { finish, startRound, stagePreflight } from "../state/prepush.js";
import {
  GATE_ATTEMPTS,
  buildRoundSummary,
  fixTargets,
  runFix,
  runGateStage,
  verifyPending,
} from "../state/steps.js";
import { titleSimilarity } from "../merge/fingerprint.js";
import { NO_HOOKS } from "../range/git.js";
import {
  GhError,
  isCopilotLogin,
  type CheckRun,
  type GitHubClient,
  type PrInfo,
  type ReviewThread,
} from "./github.js";

/** How often the loop polls the pull request. */
export const POLL_INTERVAL_MS = 60_000;
/** How long the loop waits for the review and the checks before it moves on. */
export const POLL_TIMEOUT_MS = 2 * 60 * 60_000;
/**
 * How often, and how many times, the loop looks for a timeline event after
 * a review request that the response doesn't confirm. GitHub adds the
 * event within seconds of a request it takes.
 */
export const REVIEW_CHECK_INTERVAL_MS = 10_000;
export const REVIEW_CHECK_ATTEMPTS = 3;

/** Log patterns of check failures that code changes can't fix. */
const NON_CODE_PATTERNS: RegExp[] = [
  /secret[s]? .*(not set|missing|not found|unavailable)/i,
  /(missing|undefined) (secret|token|credential)/i,
  /resource not accessible by integration/i,
  /no space left on device/i,
  /the (job|runner) (was|has) (not started|lost communication|received a shutdown signal)/i,
  /exceeded the maximum execution time/i,
  /api rate limit exceeded/i,
  /could not resolve host|network is unreachable|connection (timed out|reset)/i,
  /(quota|billing|spending limit)/i,
];

/** True when a failing check's log shows a cause outside the code, such as a missing secret. */
export function isNonCodeFailure(log: string): boolean {
  return NON_CODE_PATTERNS.some((re) => re.test(log));
}

/** Reads a severity from a comment's text, such as `P1` or `[nit]`; `P2` when it names none. */
export function severityFromText(text: string): Severity {
  const m = /\b(P[123])\b/.exec(text);
  if (m) return m[1] as Severity;
  if (/\bnit\b|nitpick/i.test(text)) return "nit";
  return "P2";
}

function firstLine(text: string, max = 120): string {
  const line =
    text
      .trim()
      .split("\n")
      .find((l) => l.trim() !== "") ?? "Review comment";
  const clean = line.replace(/^[#>*\s-]+/, "").trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean || "Review comment";
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

function github(ctx: RunContext): GitHubClient {
  if (!ctx.deps.github)
    throw new Error("The post-push loop needs the gh client, which isn't configured.");
  return ctx.deps.github;
}

/**
 * The branch a new pull request targets: the run's base as a branch name.
 * A remote-tracking base such as `upstream/main` loses its remote. A base
 * that names no branch, such as a tag or a commit, gives the default
 * branch, since a pull request can only target a branch.
 */
async function prBase(ctx: RunContext, defaultBranch: string, branch: string): Promise<string> {
  const base = ctx.state.request.base;
  let name: string | null = null;
  if (base === "pr") name = defaultBranch;
  else if (base.startsWith("refs/heads/")) name = base.slice("refs/heads/".length);
  else {
    const short = base.replace(/^refs\/remotes\//, "");
    const remotes = (await ctx.git.run(["remote"]))
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const remote = remotes.find((r) => short.startsWith(`${r}/`));
    if (remote && (await ctx.git.ok(["show-ref", "--verify", "--quiet", `refs/remotes/${short}`])))
      name = short.slice(remote.length + 1);
    else if (await ctx.git.isLocalBranch(short)) name = short;
  }
  return name === null || name === "" || name === branch ? defaultBranch : name;
}

/**
 * Pushes the tip branch and opens or updates the pull request, with every
 * guardrail. With `requestReview` false (the final push before the run
 * stops), it doesn't ask Copilot for another review.
 */
async function stagePush(ctx: RunContext, requestReview = true): Promise<PrInfo> {
  const gh = github(ctx);
  const repo = ctx.state.request.repoPath;
  const branch = ctx.eng.tipRef;
  const blocked = (message: string) =>
    new DecisionNeeded({
      kind: "push_blocked",
      findingIds: [],
      options: ["resume", "cancel"],
      message,
    });
  if (!branch) throw blocked("The run has no tip branch to push.");
  const current = await ctx.git.currentBranch();
  if (current !== branch)
    throw blocked(`The loop pushes ${branch}, but ${current ?? "a detached HEAD"} is checked out.`);
  const defaultBranch = await gh.defaultBranch(repo);
  if (branch === defaultBranch)
    throw blocked(`The loop never pushes the default branch (${defaultBranch}).`);
  let pr = ctx.state.prNumber
    ? await gh.viewPr(repo, ctx.state.prNumber)
    : await gh.findOpenPr(repo, branch);
  if (pr && pr.headRefName !== branch) {
    throw blocked(
      `Pull request #${pr.number} is for ${pr.headRefName}, not ${branch}; the loop pushes only the pull request's branch.`,
    );
  }
  if (pr && pr.state !== "OPEN") {
    throw blocked(
      `Pull request #${pr.number} is ${pr.state.toLowerCase()}; the loop works only on an open pull request.`,
    );
  }
  if (pr?.crossRepository) {
    throw blocked(
      `Pull request #${pr.number} comes from a fork; the loop works only on a pull request from this repository.`,
    );
  }
  // Settled before the push, so nothing after it can fail on the base.
  const base = pr ? null : await prBase(ctx, defaultBranch, branch);
  // Never force: a rejected push means someone else moved the branch. The
  // push runs without the repository's hooks: a `pre-push` hook can come
  // from the reviewed commits, and the push holds the GitHub token. The gate
  // has already run the policy's tests.
  const push = await ctx.deps.runner.run(
    "git",
    [...NO_HOOKS, "push", "origin", `refs/heads/${branch}:refs/heads/${branch}`],
    {
      cwd: repo,
      timeoutMs: 300_000,
      envProfile: "github",
    },
  );
  if (push.exitCode !== 0)
    throw blocked(`git push was rejected; the loop never force-pushes:\n${push.stderr.trim()}`);
  if (!pr) {
    pr = await gh.createPr(repo, {
      base: base ?? defaultBranch,
      head: branch,
      // A blank title gets the default, since gh refuses an empty one.
      title: ctx.eng.push?.title?.trim() || `Review fixes for ${branch}`,
      body: `Opened by AI Orchestrator run ${ctx.state.id}.`,
      draft: ctx.eng.push?.draft ?? false,
    });
  }
  ctx.state.prNumber = pr.number;
  ctx.state.prUrl = pr.url;
  const head = await ctx.git.head();
  ctx.state.tipSha = head;
  ctx.eng.pushedHead = head;
  let dropped = false;
  if (requestReview && ctx.eng.reviewRequestedFor !== head) {
    const refusal = await requestCopilotReview(ctx, gh, pr.number);
    dropped = refusal !== null;
    ctx.eng.reviewRequestedFor = head;
    ctx.eng.reviewDroppedFor = dropped ? head : null;
    if (refusal !== null) {
      ctx.state.notices = [
        ...(ctx.state.notices ?? []),
        `GitHub didn't take the Copilot review request for pull request #${pr.number} at ${head.slice(0, 12)}: ` +
          `${refusal} The loop doesn't wait for a Copilot review of this commit.`,
      ];
    }
  }
  await ctx.persist();
  // The notice goes out at once; the run's next change might be hours away.
  if (dropped) await ctx.emitRun();
  await ctx.store.writeJson(ctx.store.roundFile(ctx.round, "push"), { pr, head });
  await ctx.handoff(
    { stage: "push" },
    { stage: "poll", vendor: "copilot", role: "reviewer" },
    "commits",
    1,
    null,
  );
  return pr;
}

/**
 * Requests a Copilot review and resolves to `null` when GitHub took it, or
 * to the reason it didn't, as a sentence. GitHub can refuse the request
 * outright, such as with a 422 for a repository without Copilot code
 * review. It can also answer `201` and still drop the request, such as when
 * the account's Copilot review allowance is used up: the response then lists
 * no Copilot reviewer, and the timeline gets no event. A client that can't
 * read the timeline gets the benefit of the doubt.
 */
async function requestCopilotReview(
  ctx: RunContext,
  gh: GitHubClient,
  pr: number,
): Promise<string | null> {
  const repo = ctx.state.request.repoPath;
  const before = gh.copilotReviewEvents ? await gh.copilotReviewEvents(repo, pr) : null;
  let result: Awaited<ReturnType<GitHubClient["requestCopilotReview"]>>;
  try {
    result = await gh.requestCopilotReview(repo, pr);
  } catch (error) {
    if (!(error instanceof GhError)) throw error;
    ctx.deps.log?.warn("GitHub refused the Copilot review request", {
      runId: ctx.state.id,
      pr,
      error: error.message,
    });
    return `the request failed: ${error.stderr.trim() || `gh exited with code ${error.exitCode}`}.`;
  }
  if (result.requestedReviewers.some(isCopilotLogin)) return null;
  if (before === null || !gh.copilotReviewEvents) return null;
  for (let attempt = 0; attempt < REVIEW_CHECK_ATTEMPTS; attempt++) {
    try {
      await ctx.clock.sleep(REVIEW_CHECK_INTERVAL_MS, ctx.signal);
    } catch {
      await ctx.checkpoint();
    }
    if ((await gh.copilotReviewEvents(repo, pr)) > before) return null;
  }
  return (
    "the response lists no Copilot reviewer, and the timeline has no review_requested or copilot_work_started event " +
    `${(REVIEW_CHECK_ATTEMPTS * REVIEW_CHECK_INTERVAL_MS) / 1000} seconds later. ` +
    "The account's Copilot review allowance might be used up."
  );
}

interface PollResult {
  reviewed: boolean;
  checks: CheckRun[];
  timedOut: boolean;
  /** True when the poll didn't wait for a review, since GitHub dropped the request. */
  reviewDropped?: boolean;
}

/**
 * Polls until Copilot reviewed the head and no check is pending, or the
 * poll times out. When GitHub dropped the review request for the head, it
 * waits for the checks only.
 */
async function stagePoll(ctx: RunContext): Promise<PollResult> {
  const file = ctx.store.roundFile(ctx.round, "poll");
  const saved = await ctx.store.readJson<PollResult>(file);
  if (saved) return saved;
  const gh = github(ctx);
  const repo = ctx.state.request.repoPath;
  const pr = ctx.state.prNumber as number;
  const head = ctx.state.tipSha ?? (await ctx.git.head());
  const started = ctx.clock.now();
  const reviewDropped = ctx.eng.reviewDroppedFor === head;
  let result: PollResult;
  for (;;) {
    await ctx.checkpoint();
    const reviews = await gh.listReviews(repo, pr);
    const reviewed = reviews.some(
      (r) => isCopilotLogin(r.author) && (r.commitId === null || r.commitId === head),
    );
    const checks = await gh.listChecks(repo, pr);
    const pending = checks.some((c) => c.bucket === "pending");
    const timedOut = ctx.clock.now() - started >= POLL_TIMEOUT_MS;
    if (((reviewed || reviewDropped) && !pending) || timedOut) {
      result = { reviewed, checks, timedOut, ...(reviewDropped ? { reviewDropped } : {}) };
      break;
    }
    try {
      await ctx.clock.sleep(POLL_INTERVAL_MS, ctx.signal);
    } catch {
      await ctx.checkpoint();
    }
  }
  await ctx.store.writeJson(file, result);
  return result;
}

function threadFinding(ctx: RunContext, thread: ReviewThread): Finding | null {
  const first = thread.comments[0];
  if (!first) return null;
  const located = thread.path !== null && thread.line !== null;
  const start = located ? (thread.startLine ?? thread.line ?? 1) : null;
  const end = located ? (thread.line ?? start ?? 1) : null;
  const text = thread.comments.map((c) => `${c.author}: ${c.body}`).join("\n\n");
  const title = firstLine(first.body);
  return FindingInputSchema.parse({
    id: ctx.nextFindingId(),
    fingerprint: sha1(`${thread.path ?? ""}\n\n${title.toLowerCase()}`),
    severity: severityFromText(first.body),
    title,
    file: located ? thread.path : null,
    lines: located
      ? [Math.min(start as number, end as number), Math.max(start as number, end as number)]
      : null,
    failureCase: first.body,
    category: "review-comment",
    introduced: true,
    reportedBy: isCopilotLogin(first.author)
      ? "copilot-review"
      : `github-${first.author || "reviewer"}`,
    verdict: "pending",
    evidence: text,
    runId: ctx.state.id,
    round: ctx.round,
    groupId: null,
    origin: "pr_comment",
    externalRef: { kind: "pr_comment", id: thread.id, ...(first.url ? { url: first.url } : {}) },
  });
}

function checkFinding(ctx: RunContext, check: CheckRun, log: string, head: string): Finding {
  const tail = log.trim().split("\n").slice(-60).join("\n");
  return FindingInputSchema.parse({
    id: ctx.nextFindingId(),
    fingerprint: sha1(`check\n${check.name}`),
    severity: "P1",
    title: `Check ${check.name} fails`,
    file: null,
    lines: null,
    failureCase: `The ${check.name} check fails on ${head}.`,
    category: "check-failure",
    introduced: true,
    reportedBy: `check-${check.workflow ?? check.name}`,
    verdict: "pending",
    evidence: tail,
    runId: ctx.state.id,
    round: ctx.round,
    groupId: null,
    origin: "check_run",
    externalRef: {
      kind: "check_run",
      id: `${check.name}@${head}`,
      ...(check.link ? { url: check.link } : {}),
    },
  });
}

export interface ImportRecord {
  imported: string[];
  nonCode: Array<{ check: string; reason: string }>;
  failingCode: string[];
  checksPassed: boolean;
}

/**
 * The logins whose comments the loop imports: the policy's
 * `commentAuthors`, else the repository's collaborators, else (when the
 * token can't list collaborators) only Copilot and the pull request's
 * author. Lowercased.
 */
export async function allowedCommentAuthors(ctx: RunContext): Promise<Set<string>> {
  const configured = ctx.extras.commentAuthors;
  if (configured) return new Set(configured.map((l) => l.toLowerCase()));
  const gh = github(ctx);
  const repo = ctx.state.request.repoPath;
  const collaborators = (await gh.listCollaborators?.(repo)) ?? null;
  if (collaborators) return new Set(collaborators.map((l) => l.toLowerCase()));
  const out = new Set<string>();
  const pr = ctx.state.prNumber ? await gh.viewPr(repo, ctx.state.prNumber) : null;
  if (pr?.author) out.add(pr.author.toLowerCase());
  return out;
}

function isAllowedAuthor(login: string, allowed: ReadonlySet<string>): boolean {
  return isCopilotLogin(login) || allowed.has(login.toLowerCase());
}

/** Imports unresolved review threads and failing checks as findings. */
async function stageImport(ctx: RunContext, poll: PollResult): Promise<ImportRecord> {
  const file = ctx.store.roundFile(ctx.round, "import");
  const saved = await ctx.store.readJson<ImportRecord>(file);
  if (saved) return saved;
  // The import is saved in one commit file before it changes the run, the
  // way `mergeInto` saves a merge: a stage that resumes after the findings
  // were saved, but before `import.json`, applies that file again instead
  // of finding every thread already known and importing nothing.
  const commitFile = ctx.store.roundFile(ctx.round, "import-commit");
  let commit = await ctx.store.readJson<ImportCommit>(commitFile);
  if (!commit) {
    commit = await collectImport(ctx, poll);
    await ctx.store.writeJson(commitFile, commit);
  }
  const { imported, oscillations } = commit;
  if (!ctx.eng.appliedMerges.includes(commitFile)) {
    const have = new Set(ctx.findings.map((f) => f.id));
    ctx.findings.push(...imported.filter((f) => !have.has(f.id)));
    ctx.eng.importedRefs = commit.importedRefs;
    ctx.eng.counters.finding = Math.max(ctx.eng.counters.finding, commit.findingCounter);
    await ctx.persist();
    for (const f of imported) {
      const live = ctx.findingById(f.id);
      if (live) await ctx.announceFinding(live);
    }
    ctx.eng.appliedMerges = [...ctx.eng.appliedMerges, commitFile];
    await ctx.persist();
  }
  const record: ImportRecord = {
    imported: imported.map((f) => f.id),
    nonCode: commit.nonCode,
    failingCode: commit.failingCode,
    checksPassed: poll.checks.every((c) => c.bucket !== "fail" && c.bucket !== "pending"),
  };
  await ctx.store.writeJson(file, record);
  await ctx.handoff(
    { stage: "import", vendor: "copilot", role: "reviewer" },
    { stage: "verify", role: "disprover" },
    "findings",
    imported.length,
    file,
  );
  if (oscillations.length > 0) {
    await ctx.setStage("verify");
    throw new DecisionNeeded({
      kind: "oscillation",
      findingIds: oscillations.flatMap((o) => [o.fixedId, o.returnedId]),
      options: ["resume", "resume_waive", "cancel"],
      message: "A pull request comment raises a finding that an earlier fix closed.",
    });
  }
  return record;
}

/** One import, as `stageImport` saves it before it changes the run. */
interface ImportCommit {
  imported: Finding[];
  importedRefs: string[];
  findingCounter: number;
  nonCode: ImportRecord["nonCode"];
  failingCode: string[];
  oscillations: Array<{ fixedId: string; returnedId: string }>;
}

/** Reads the threads and failing checks to import, without changing the run's findings. */
async function collectImport(ctx: RunContext, poll: PollResult): Promise<ImportCommit> {
  const gh = github(ctx);
  const repo = ctx.state.request.repoPath;
  const pr = ctx.state.prNumber as number;
  const head = ctx.state.tipSha ?? (await ctx.git.head());
  const imported: Finding[] = [];
  const known = new Set(ctx.eng.importedRefs);

  const allowed = await allowedCommentAuthors(ctx);
  for (const thread of await gh.listReviewThreads(repo, pr)) {
    if (thread.isResolved || known.has(thread.id)) continue;
    // A thread counts only when a trusted author started it, and only
    // trusted authors' replies go into the finding.
    const first = thread.comments[0];
    if (!first || !isAllowedAuthor(first.author, allowed)) continue;
    const trusted = {
      ...thread,
      comments: thread.comments.filter((c) => isAllowedAuthor(c.author, allowed)),
    };
    const f = threadFinding(ctx, trusted);
    if (!f) continue;
    known.add(thread.id);
    imported.push(f);
  }
  const nonCode: ImportRecord["nonCode"] = [];
  const failingCode: string[] = [];
  for (const check of poll.checks.filter((c) => c.bucket === "fail")) {
    const log = await gh.failedCheckLog(repo, check);
    if (isNonCodeFailure(log)) {
      nonCode.push({
        check: check.name,
        reason: firstLine(log.split("\n").find((l) => isNonCodeFailure(l)) ?? log),
      });
      continue;
    }
    failingCode.push(check.name);
    const ref = `${check.name}@${head}`;
    if (known.has(ref)) continue;
    known.add(ref);
    imported.push(checkFinding(ctx, check, log, head));
  }

  // A comment that matches a fixed finding is an oscillation.
  const oscillations: Array<{ fixedId: string; returnedId: string }> = [];
  for (const f of imported) {
    const fixed = ctx.findings.find(
      (x) =>
        x.verdict === "fixed" &&
        x.file !== null &&
        x.file === f.file &&
        titleSimilarity(x.title, f.title) >= 0.5 &&
        !ctx.eng.acceptedOscillations.includes(x.id),
    );
    if (fixed) oscillations.push({ fixedId: fixed.id, returnedId: f.id });
    f.history.push({
      time: ctx.nowIso(),
      verdict: "pending",
      actor: { kind: "engine", role: "import" },
      round: ctx.round,
    });
  }
  return {
    imported,
    importedRefs: [...known],
    findingCounter: ctx.eng.counters.finding,
    nonCode,
    failingCode,
    oscillations,
  };
}

/**
 * Replies to and resolves the threads of disproved or fixed comment
 * findings. Each reply and each resolve is recorded as soon as it succeeds,
 * so a retry after a failure never replies twice. A "fixed" answer goes only
 * to a finding whose fix is pushed.
 */
async function answerThreads(ctx: RunContext, kind: "disproved" | "fixed"): Promise<void> {
  const gh = github(ctx);
  const repo = ctx.state.request.repoPath;
  for (const f of ctx.findings) {
    if (f.origin !== "pr_comment" || f.verdict !== kind || !f.externalRef) continue;
    const thread = f.externalRef.id;
    if (ctx.eng.resolvedThreads.includes(thread)) continue;
    if (kind === "fixed" && !(await fixIsPushed(ctx, f))) continue;
    if (!ctx.eng.answeredThreads.includes(thread)) {
      const last = [...f.history].reverse().find((h) => h.verdict === kind);
      const body =
        kind === "disproved"
          ? `Verified by an independent agent, which found this doesn't reproduce:\n\n${(last?.evidence ?? f.evidence).slice(0, 3000)}`
          : `Fixed in ${f.fixCommit ?? ctx.eng.pushedHead ?? "the latest push"}.`;
      await gh.replyToThread(repo, thread, body);
      ctx.eng.answeredThreads = [...ctx.eng.answeredThreads, thread];
      await ctx.persist();
    }
    await gh.resolveThread(repo, thread);
    ctx.eng.resolvedThreads = [...ctx.eng.resolvedThreads, thread];
    await ctx.persist();
  }
}

/** True when the finding's fix commit is in the last push. */
async function fixIsPushed(ctx: RunContext, f: Finding): Promise<boolean> {
  const pushed = ctx.eng.pushedHead;
  if (!pushed) return false;
  if (!f.fixCommit || f.fixCommit === pushed) return true;
  return ctx.git.ok(["merge-base", "--is-ancestor", f.fixCommit, pushed]);
}

/** Rounds since the post-push loop started; it has its own round cap. */
function postPushRounds(ctx: RunContext): number {
  return ctx.round - (ctx.eng.postPushStartRound ?? 0);
}

/**
 * Finishes the run. Fixes committed since the last push are pushed first,
 * and their threads answered, so no stop leaves a fix behind on the local
 * branch. A rejected push raises `push_blocked` instead of finishing.
 */
async function finishPostPush(
  ctx: RunContext,
  reason: Parameters<typeof finish>[1],
): Promise<void> {
  if (ctx.eng.pushedHead !== null && (await ctx.git.head()) !== ctx.eng.pushedHead) {
    await stagePush(ctx, false);
    await answerThreads(ctx, "fixed");
  }
  await finish(ctx, reason);
}

async function closePostPushRound(ctx: RunContext): Promise<void> {
  const summary = buildRoundSummary(ctx, {}, 0);
  await ctx.store.saveRoundSummary(summary);
  ctx.eng.roundOpen = false;
  await ctx.persist();
  await ctx.emitRun(summary);
}

/** Closes the round and finishes the run at the post-push round cap. Returns true when it finished. */
async function endPostPushRound(ctx: RunContext): Promise<boolean> {
  await closePostPushRound(ctx);
  if (postPushRounds(ctx) >= postPushRoundCap(ctx.state.request)) {
    await finishPostPush(ctx, "round_cap");
    return true;
  }
  return false;
}

/** Drives the post-push loop until the pull request is clean, the run waits, or it fails. */
export async function drivePostPush(ctx: RunContext): Promise<void> {
  // The request schema refuses this combination, but a run stored before
  // that check existed can still carry it, and the loop pushes and commits.
  if (isReadOnlyPostPush(ctx.state.request)) throw new Error(READ_ONLY_POST_PUSH_MESSAGE);
  for (;;) {
    await ctx.checkpoint();
    switch (ctx.state.stage) {
      case "preflight":
        await stagePreflight(ctx);
        await ctx.setStage("push");
        break;
      case "push": {
        await startRound(ctx);
        await stagePush(ctx);
        // The fixes are on GitHub now, so their threads can say so.
        await answerThreads(ctx, "fixed");
        await ctx.setStage("poll");
        break;
      }
      case "poll":
        await stagePoll(ctx);
        await ctx.setStage("import");
        break;
      case "import": {
        const poll =
          (await ctx.store.readJson<PollResult>(ctx.store.roundFile(ctx.round, "poll"))) ??
          (await stagePoll(ctx));
        const record = await stageImport(ctx, poll);
        // An imported finding still pending, such as from an import that a
        // restart cut short before it saved its record, needs the round too.
        const actionable =
          record.imported.length > 0 ||
          ctx.findings.some(
            (f) =>
              f.verdict === "pending" && (f.origin === "pr_comment" || f.origin === "check_run"),
          );
        if (!actionable) {
          await closePostPushRound(ctx);
          // A clean pull request needs the review the poll waited for.
          if (poll.timedOut && !poll.reviewed && !poll.reviewDropped) {
            const head = (ctx.state.tipSha ?? "").slice(0, 12);
            throw new DecisionNeeded({
              kind: "gate_failed",
              findingIds: [],
              options: ["resume", "cancel"],
              message: `Copilot didn't review ${head || "the pull request's head"} within ${POLL_TIMEOUT_MS / 3_600_000} hours. Resume to poll again, or cancel.`,
            });
          }
          if (record.failingCode.length === 0 && record.checksPassed) {
            await finishPostPush(ctx, "pr_clean");
            return;
          }
          if (record.failingCode.length === 0 && record.nonCode.length > 0) {
            await finishPostPush(ctx, "non_code_failures");
            return;
          }
          if (postPushRounds(ctx) >= postPushRoundCap(ctx.state.request)) {
            await finishPostPush(ctx, "round_cap");
            return;
          }
          if (record.failingCode.length === 0) {
            throw new DecisionNeeded({
              kind: "gate_failed",
              findingIds: [],
              options: ["resume", "cancel"],
              message: "The checks didn't finish before the poll timed out. Resume to poll again.",
            });
          }
          // A failing check already imported and not fixable: stop for a person.
          throw new DecisionNeeded({
            kind: "gate_failed",
            findingIds: [],
            options: ["resume", "cancel"],
            message: `Checks still fail with no new finding: ${record.failingCode.join(", ")}.`,
          });
        }
        await ctx.setStage("verify");
        break;
      }
      case "verify":
        await verifyPending(ctx, ctx.store.roundFile(ctx.round, "verify"));
        await answerThreads(ctx, "disproved");
        await ctx.setStage("fix");
        break;
      case "fix": {
        const targets = fixTargets(ctx);
        if (targets.length === 0 && ctx.eng.gateAttempts === 0) {
          if (await endPostPushRound(ctx)) return;
          await ctx.setStage("push");
          break;
        }
        await runFix(ctx, targets, ctx.eng.lastGateFailure ?? undefined);
        await ctx.setStage("gate");
        break;
      }
      case "gate": {
        const record = await runGateStage(ctx, "push");
        if (record.regressed) {
          ctx.eng.gateAttempts += 1;
          ctx.eng.lastGateFailure = record.report;
          await ctx.persist();
          if (ctx.eng.gateAttempts >= GATE_ATTEMPTS) {
            throw new DecisionNeeded({
              kind: "gate_failed",
              findingIds: [],
              options: ["resume", "cancel"],
              message: `The fixes still break the test or lint gate after ${GATE_ATTEMPTS} attempts:\n${record.report}`,
            });
          }
          await ctx.setStage("fix");
          break;
        }
        ctx.eng.lastGateFailure = null;
        // No confirmer after push: the next Copilot review checks the fixes.
        for (const f of ctx.findings.filter((x) => x.verdict === "confirmed" && x.fixCommit)) {
          await ctx.setVerdict(
            f,
            "fixed",
            { kind: "engine", role: "gate" },
            `Fixed in ${f.fixCommit}; the gate passed.`,
          );
        }
        // The threads are answered after the next push, which carries the fixes.
        if (await endPostPushRound(ctx)) return;
        await ctx.setStage("push");
        break;
      }
      default:
        return;
    }
  }
}
