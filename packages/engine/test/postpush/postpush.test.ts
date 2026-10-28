import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FakeClock,
  GrantingBroker,
  MemoryEventSink,
  type CommandRunner,
  type EngineDeps,
} from "../../src/core.js";
import {
  GhCliClient,
  isCopilotLogin,
  type CheckRun,
  type CreatePrInput,
  type GitHubClient,
  type PrInfo,
  type PrReview,
  type ReviewThread,
} from "../../src/postpush/github.js";
import { isNonCodeFailure, severityFromText } from "../../src/postpush/loop.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { RunController } from "../../src/state/controller.js";
import { Scenario, buildSampleRepo } from "../state/scenario.js";

let seq = 500;
const nextRunId = () => `01JD${String(++seq).padStart(22, "0")}`;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A pull request on a bare origin repository, with scripted review threads and checks. */
class FakeGitHub implements GitHubClient {
  pr: PrInfo | null = null;
  reviewRequests: string[] = [];
  replies: Array<{ thread: string; body: string }> = [];
  resolved = new Set<string>();
  threads: ReviewThread[] = [];
  checks: CheckRun[] = [
    { name: "tests", bucket: "pass", link: null, workflow: "ci" },
    {
      name: "deploy",
      bucket: "fail",
      link: "https://github.com/o/r/actions/runs/1/job/2",
      workflow: "deploy",
    },
  ];

  constructor(private readonly origin: string) {}

  private head(branch: string): string {
    return git(this.origin, "rev-parse", `refs/heads/${branch}`);
  }

  async viewPr(): Promise<PrInfo | null> {
    return this.pr ? { ...this.pr, headSha: this.head(this.pr.headRefName) } : null;
  }
  async findOpenPr(): Promise<PrInfo | null> {
    return this.viewPr();
  }
  async createPr(_repo: string, input: CreatePrInput): Promise<PrInfo> {
    this.pr = {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      headRefName: input.head,
      baseRefName: input.base,
      headSha: this.head(input.head),
      state: "OPEN",
    };
    return this.pr;
  }
  async defaultBranch(): Promise<string> {
    return "main";
  }
  async requestCopilotReview(): Promise<void> {
    this.reviewRequests.push(this.head(this.pr?.headRefName ?? "feature"));
  }
  async listReviews(): Promise<PrReview[]> {
    return this.reviewRequests.map((sha, i) => ({
      id: String(i),
      author: "copilot-pull-request-reviewer[bot]",
      state: "COMMENTED",
      commitId: sha,
      submittedAt: null,
    }));
  }
  async listReviewThreads(): Promise<ReviewThread[]> {
    return this.threads.map((t) => ({ ...t, isResolved: this.resolved.has(t.id) }));
  }
  async listChecks(): Promise<CheckRun[]> {
    return this.checks;
  }
  async failedCheckLog(_repo: string, check: CheckRun): Promise<string> {
    return check.name === "deploy"
      ? "Run deploy\nError: secret DEPLOY_KEY is not set\n"
      : "FAIL test_x";
  }
  async replyToThread(_repo: string, thread: string, body: string): Promise<void> {
    this.replies.push({ thread, body });
  }
  async resolveThread(_repo: string, thread: string): Promise<void> {
    this.resolved.add(thread);
  }
}

function lineOf(repo: string, file: string, text: string): number {
  return (
    readFileSync(join(repo, file), "utf8")
      .split("\n")
      .findIndex((l) => l.includes(text)) + 1
  );
}

function deps(scenario: Scenario, github: GitHubClient): EngineDeps & { events: MemoryEventSink } {
  const clock = new FakeClock();
  return {
    adapters: scenario.adapters(),
    broker: new GrantingBroker(clock),
    events: new MemoryEventSink("engine:test", "s", clock),
    runner: new ExecaRunner(),
    github,
    clock,
    container: "c",
  };
}

describe("post-push loop", () => {
  it("pushes, imports comments and checks, replies, fixes, and stops on non-code failures", async () => {
    const repo = buildSampleRepo();
    const origin = join(dirname(repo), "origin.git");
    const gh = new FakeGitHub(origin);
    const scenario = new Scenario();
    const b3 = scenario.bugs.find((b) => b.id === "B3")!;
    const fp = scenario.bugs.find((b) => b.id === "FP1")!;
    const line = lineOf(repo, "shop/pricing.py", "if quantity > 100");
    gh.threads = [
      {
        id: "T1",
        isResolved: false,
        path: "shop/pricing.py",
        line: line + 1,
        startLine: line,
        comments: [
          {
            id: "c1",
            author: "Copilot",
            body: `${b3.title}\n\nThe docstring says 100 or more.`,
            url: null,
          },
        ],
      },
      {
        id: "T2",
        isResolved: false,
        path: "shop/pricing.py",
        line: 11,
        startLine: null,
        comments: [{ id: "c2", author: "Copilot", body: fp.title, url: null }],
      },
    ];
    const d = deps(scenario, gh);
    const run = await RunController.create(
      { runId: nextRunId(), projectId: "sample", repoPath: repo, pipeline: "post-push" },
      { projectRoot: repo },
      d,
    );
    await run.start();
    const state = await run.settled();
    expect(state.error).toBeUndefined();
    expect(state).toMatchObject({
      status: "finished",
      stopReason: "non_code_failures",
      prNumber: 7,
    });

    const findings = run.findings;
    const t1 = findings.find((f) => f.externalRef?.id === "T1");
    const t2 = findings.find((f) => f.externalRef?.id === "T2");
    expect(t1).toMatchObject({ origin: "pr_comment", verdict: "fixed", file: "shop/pricing.py" });
    expect(t2).toMatchObject({ origin: "pr_comment", verdict: "disproved" });
    expect(findings.some((f) => f.origin === "check_run")).toBe(false);

    expect(gh.replies.find((r) => r.thread === "T2")?.body).toMatch(/doesn't reproduce/);
    expect(gh.replies.find((r) => r.thread === "T1")?.body).toMatch(/^Fixed in [0-9a-f]{40}/);
    expect([...gh.resolved].sort()).toEqual(["T1", "T2"]);
    // A review per pushed head; the fix reached origin without a force push.
    expect(gh.reviewRequests).toHaveLength(2);
    expect(git(origin, "rev-parse", "refs/heads/feature")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(git(repo, "rev-parse", "main"));
    expect(scenario.count("fix")).toBe(1);
  });

  it("stops at a clean pull request when nothing is new and the checks pass", async () => {
    const repo = buildSampleRepo();
    const gh = new FakeGitHub(join(dirname(repo), "origin.git"));
    gh.checks = [{ name: "tests", bucket: "pass", link: null, workflow: "ci" }];
    const run = await RunController.create(
      { runId: nextRunId(), projectId: "sample", repoPath: repo, pipeline: "post-push" },
      { projectRoot: repo },
      deps(new Scenario(), gh),
    );
    await run.start();
    expect(await run.settled()).toMatchObject({
      status: "finished",
      stopReason: "pr_clean",
      round: 1,
    });
  });

  it("never pushes the default branch", async () => {
    const repo = buildSampleRepo();
    git(repo, "checkout", "-q", "main");
    const gh = new FakeGitHub(join(dirname(repo), "origin.git"));
    const run = await RunController.create(
      { runId: nextRunId(), projectId: "sample", repoPath: repo, pipeline: "post-push" },
      { projectRoot: repo },
      deps(new Scenario(), gh),
    );
    await run.start();
    const state = await run.settled();
    expect(state).toMatchObject({ status: "waiting_decision" });
    expect(state.decision?.kind).toBe("push_blocked");
    expect(state.decision?.message).toMatch(/default branch/);
  });

  it("never force-pushes over a branch that moved on origin", async () => {
    const repo = buildSampleRepo();
    const origin = join(dirname(repo), "origin.git");
    const other = mkdtempSync(join(tmpdir(), "agentbox-other-"));
    git(other, "clone", "-q", origin, "c");
    const clone = join(other, "c");
    git(clone, "checkout", "-q", "-b", "feature");
    writeFileSync(join(clone, "x.txt"), "x\n");
    git(clone, "add", "x.txt");
    git(
      clone,
      "-c",
      "user.name=o",
      "-c",
      "user.email=o@example.com",
      "commit",
      "-q",
      "-m",
      "other",
    );
    git(clone, "push", "-q", "origin", "feature");
    const theirs = git(origin, "rev-parse", "refs/heads/feature");
    const run = await RunController.create(
      { runId: nextRunId(), projectId: "sample", repoPath: repo, pipeline: "post-push" },
      { projectRoot: repo },
      deps(new Scenario(), new FakeGitHub(origin)),
    );
    await run.start();
    const state = await run.settled();
    expect(state.decision?.kind).toBe("push_blocked");
    expect(state.decision?.message).toMatch(/never force-pushes/);
    expect(git(origin, "rev-parse", "refs/heads/feature")).toBe(theirs);
  });

  it("starts after a finished pre-push run", async () => {
    const repo = buildSampleRepo();
    const gh = new FakeGitHub(join(dirname(repo), "origin.git"));
    gh.checks = [];
    const scenario = new Scenario();
    const run = await RunController.create(
      { runId: nextRunId(), projectId: "sample", repoPath: repo },
      { projectRoot: repo },
      deps(scenario, gh),
    );
    await run.start();
    expect((await run.settled()).stopReason).toBe("clean");
    await run.push({ title: "Shop fixes" });
    const state = await run.settled();
    expect(state).toMatchObject({ status: "finished", stopReason: "pr_clean", prNumber: 7 });
    expect(state.round).toBe(5);
  });
});

describe("post-push helpers", () => {
  it("classifies check failures and comment severities", () => {
    expect(isNonCodeFailure("Error: secret DEPLOY_KEY is not set")).toBe(true);
    expect(isNonCodeFailure("No space left on device")).toBe(true);
    expect(isNonCodeFailure("AssertionError: 1 != 2")).toBe(false);
    expect(severityFromText("**P1** crash")).toBe("P1");
    expect(severityFromText("nit: rename")).toBe("nit");
    expect(severityFromText("This looks wrong")).toBe("P2");
    expect(isCopilotLogin("Copilot")).toBe(true);
    expect(isCopilotLogin("copilot-pull-request-reviewer[bot]")).toBe(true);
    expect(isCopilotLogin("octocat")).toBe(false);
  });
});

describe("GhCliClient", () => {
  function scripted(
    answers: Record<string, { stdout?: string; exitCode?: number; stderr?: string }>,
  ) {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run: async (program, args) => {
        calls.push([program, ...args]);
        const key = Object.keys(answers).find((k) => [program, ...args].join(" ").startsWith(k));
        const a = key ? answers[key]! : {};
        return {
          exitCode: a.exitCode ?? 0,
          stdout: a.stdout ?? "",
          stderr: a.stderr ?? "",
          timedOut: false,
        };
      },
    };
    return { runner, calls };
  }

  it("builds the gh command lines", async () => {
    const pr = {
      number: 3,
      url: "https://github.com/o/r/pull/3",
      headRefName: "f",
      baseRefName: "main",
      headRefOid: "abc1234",
      state: "OPEN",
    };
    const { runner, calls } = scripted({
      "gh pr view": { stdout: JSON.stringify(pr) },
      "gh pr list": { stdout: "[]" },
      "gh pr checks": {
        stdout: JSON.stringify([
          { name: "ci", bucket: "fail", link: "https://github.com/o/r/actions/runs/9/job/8" },
        ]),
        exitCode: 1,
      },
      "gh api --paginate": {
        stdout: JSON.stringify([
          {
            id: 1,
            user: { login: "Copilot" },
            state: "COMMENTED",
            commit_id: "abc",
            submitted_at: null,
          },
        ]),
      },
      "gh api graphql -f query=query": {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: "T",
                      isResolved: false,
                      path: "a",
                      line: 2,
                      startLine: null,
                      comments: {
                        nodes: [{ id: "c", body: "b", url: null, author: { login: "Copilot" } }],
                      },
                    },
                  ],
                },
              },
            },
          },
        }),
      },
    });
    const gh = new GhCliClient(runner);
    expect((await gh.viewPr("/r", 3))?.headSha).toBe("abc1234");
    expect(await gh.findOpenPr("/r", "f")).toBeNull();
    const checks = await gh.listChecks("/r", 3);
    expect(checks[0]).toMatchObject({ name: "ci", bucket: "fail" });
    await gh.failedCheckLog("/r", checks[0]!);
    expect((await gh.listReviews("/r", 3))[0]).toMatchObject({
      author: "Copilot",
      commitId: "abc",
    });
    expect((await gh.listReviewThreads("/r", 3))[0]?.comments[0]?.author).toBe("Copilot");
    await gh.requestCopilotReview("/r", 3);
    await gh.replyToThread("/r", "T", "hi");
    await gh.resolveThread("/r", "T");
    expect(calls.find((c) => c[1] === "run")).toEqual([
      "gh",
      "run",
      "view",
      "9",
      "--log-failed",
      "--job",
      "8",
    ]);
    expect(calls.find((c) => c.includes("--method"))).toEqual([
      "gh",
      "api",
      "--method",
      "POST",
      "repos/{owner}/{repo}/pulls/3/requested_reviewers",
      "-f",
      "reviewers[]=copilot-pull-request-reviewer[bot]",
    ]);
    expect(
      calls.some((c) => c.includes("thread=T") && c.some((a) => a.includes("resolveReviewThread"))),
    ).toBe(true);
    expect(calls.every((c) => !c.includes("--force"))).toBe(true);
  });
});
