// The GitHub operations the engine needs, behind an interface so tests can
// script them. `GhCliClient` implements them with the `gh` CLI.
import type { CommandRunner } from "../core.js";

export interface PrInfo {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  headSha: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  /** The login of the pull request's author, when known. */
  author?: string;
  /** True when the head branch is in a fork, not in this repository. */
  crossRepository?: boolean;
}

export interface PrReview {
  id: string;
  author: string;
  state: string;
  /** The head commit the review looked at. */
  commitId: string | null;
  submittedAt: string | null;
}

export interface ThreadComment {
  id: string;
  author: string;
  body: string;
  url: string | null;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  startLine: number | null;
  comments: ThreadComment[];
}

export type CheckBucket = "pass" | "fail" | "pending" | "skipping" | "cancel";

export interface CheckRun {
  name: string;
  bucket: CheckBucket;
  link: string | null;
  workflow: string | null;
}

/** What GitHub answered to a review request. */
export interface ReviewRequestResult {
  /** The logins that the pull request's `requested_reviewers` lists after the request. */
  requestedReviewers: string[];
}

export interface CreatePrInput {
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface GitHubClient {
  /** The pull request for a number or a branch, or `null` when there is none. */
  viewPr(repoPath: string, selector: number | string): Promise<PrInfo | null>;
  /** The open pull request whose head is `branch` in this repository, not a fork, or `null`. */
  findOpenPr(repoPath: string, branch: string): Promise<PrInfo | null>;
  createPr(repoPath: string, input: CreatePrInput): Promise<PrInfo>;
  defaultBranch(repoPath: string): Promise<string>;
  /** Asks Copilot to review the pull request. GitHub can drop the request without an error. */
  requestCopilotReview(repoPath: string, pr: number): Promise<ReviewRequestResult>;
  /**
   * How many events on the pull request's timeline show that GitHub took a
   * Copilot review request: `review_requested` for Copilot, and
   * `copilot_work_started`. Absent, the loop can't check a request that the
   * response doesn't confirm, and trusts it.
   */
  copilotReviewEvents?(repoPath: string, pr: number): Promise<number>;
  listReviews(repoPath: string, pr: number): Promise<PrReview[]>;
  listReviewThreads(repoPath: string, pr: number): Promise<ReviewThread[]>;
  listChecks(repoPath: string, pr: number): Promise<CheckRun[]>;
  /** The log of the failed steps of a check, or an empty string. */
  failedCheckLog(repoPath: string, check: CheckRun): Promise<string>;
  replyToThread(repoPath: string, threadId: string, body: string): Promise<void>;
  resolveThread(repoPath: string, threadId: string): Promise<void>;
  /**
   * The logins of the repository's collaborators, or `null` when the token
   * can't list them (listing needs push access).
   */
  listCollaborators?(repoPath: string): Promise<string[] | null>;
}

/** The login GitHub uses for Copilot's pull request reviews. */
export const COPILOT_REVIEWER = "copilot-pull-request-reviewer[bot]";

/** True when `login` is Copilot's reviewer, in any of the forms GitHub returns. */
export function isCopilotLogin(login: string): boolean {
  const l = login.toLowerCase();
  return l === "copilot" || l.startsWith("copilot-pull-request-reviewer");
}

const PR_FIELDS = "number,url,headRefName,baseRefName,headRefOid,state,author,isCrossRepository";

interface RawPr {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  state: PrInfo["state"];
  author?: { login?: string } | null;
  isCrossRepository?: boolean;
}

function toPr(raw: RawPr): PrInfo {
  return {
    number: raw.number,
    url: raw.url,
    headRefName: raw.headRefName,
    baseRefName: raw.baseRefName,
    headSha: raw.headRefOid,
    state: raw.state,
    ...(raw.author?.login ? { author: raw.author.login } : {}),
    ...(raw.isCrossRepository === undefined ? {} : { crossRepository: raw.isCrossRepository }),
  };
}

export class GhError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(
      `gh ${args[0] ?? ""} ${args[1] ?? ""} failed with exit code ${exitCode}: ${stderr.trim()}`,
    );
    this.name = "GhError";
  }
}

// GraphQL returns at most 100 nodes a page, so both lists are paged with
// their cursors: the threads, and the comments of any thread with more.
const COMMENT_FIELDS = "pageInfo { hasNextPage endCursor } nodes { id body url author { login } }";

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved path line startLine
          comments(first: 100) { ${COMMENT_FIELDS} }
        }
      }
    }
  }
}`;

const THREAD_COMMENTS_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequestReviewThread { comments(first: 100, after: $after) { ${COMMENT_FIELDS} } }
  }
}`;

/** The most pages the client reads of one list, so a bad cursor can't loop forever. */
const MAX_PAGES = 100;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface RawComment {
  id: string;
  body: string;
  url: string | null;
  author: { login: string } | null;
}

interface RawCommentPage {
  pageInfo?: PageInfo;
  nodes: RawComment[];
}

interface RawThread {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  startLine: number | null;
  comments: RawCommentPage;
}

/** The cursor of the next page, or `null` when there is none. */
function nextCursor(page: PageInfo | undefined): string | null {
  return page?.hasNextPage && page.endCursor ? page.endCursor : null;
}

const REPLY_MUTATION = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { id } }
}`;

const RESOLVE_MUTATION = `mutation($thread: ID!) {
  resolveReviewThread(input: {threadId: $thread}) { thread { id } }
}`;

/**
 * Selects the timeline events that show GitHub took a Copilot review
 * request, with the logins `isCopilotLogin` accepts.
 */
const COPILOT_EVENTS_JQ =
  '.[] | select(.event == "copilot_work_started" or (.event == "review_requested" and ' +
  '((.requested_reviewer.login // "") | ascii_downcase | . == "copilot" or ' +
  'startswith("copilot-pull-request-reviewer")))) | .event';

/** `GitHubClient` over the `gh` CLI, run in the repository directory. */
export class GhCliClient implements GitHubClient {
  constructor(private readonly runner: CommandRunner) {}

  private async gh(repoPath: string, args: string[], allowFail = false): Promise<string> {
    const result = await this.runner.run("gh", args, { cwd: repoPath, timeoutMs: 120_000 });
    if (result.exitCode !== 0) {
      if (allowFail) return "";
      throw new GhError(args, result.exitCode, result.stderr);
    }
    return result.stdout;
  }

  async viewPr(repoPath: string, selector: number | string): Promise<PrInfo | null> {
    const out = await this.gh(
      repoPath,
      ["pr", "view", String(selector), "--json", PR_FIELDS],
      true,
    );
    return out.trim() === "" ? null : toPr(JSON.parse(out) as RawPr);
  }

  async findOpenPr(repoPath: string, branch: string): Promise<PrInfo | null> {
    const out = await this.gh(repoPath, [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      PR_FIELDS,
    ]);
    // `--head` matches the branch name only, so a fork's pull request from a
    // branch of the same name is in the list too.
    const list = JSON.parse(out || "[]") as RawPr[];
    const own = list.find((pr) => pr.isCrossRepository === false);
    return own ? toPr(own) : null;
  }

  async createPr(repoPath: string, input: CreatePrInput): Promise<PrInfo> {
    const args = [
      "pr",
      "create",
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    if (input.draft) args.push("--draft");
    const url = (await this.gh(repoPath, args)).trim().split("\n").pop() ?? "";
    const pr = await this.viewPr(repoPath, url || input.head);
    if (!pr)
      throw new Error(
        `gh pr create succeeded, but the pull request for ${input.head} isn't visible.`,
      );
    return pr;
  }

  async defaultBranch(repoPath: string): Promise<string> {
    const out = await this.gh(repoPath, [
      "repo",
      "view",
      "--json",
      "defaultBranchRef",
      "-q",
      ".defaultBranchRef.name",
    ]);
    return out.trim();
  }

  async requestCopilotReview(repoPath: string, pr: number): Promise<ReviewRequestResult> {
    const out = await this.gh(repoPath, [
      "api",
      "--method",
      "POST",
      `repos/{owner}/{repo}/pulls/${pr}/requested_reviewers`,
      "-f",
      `reviewers[]=${COPILOT_REVIEWER}`,
    ]);
    let body: { requested_reviewers?: Array<{ login?: string } | null> } = {};
    try {
      body = JSON.parse(out || "{}") as typeof body;
    } catch {
      // An answer that isn't JSON confirms nothing; the timeline decides.
    }
    return {
      requestedReviewers: (body.requested_reviewers ?? [])
        .map((r) => r?.login ?? "")
        .filter((login) => login !== ""),
    };
  }

  async copilotReviewEvents(repoPath: string, pr: number): Promise<number> {
    // `--jq` prints one line per matching event, on every page.
    const out = await this.gh(repoPath, [
      "api",
      "--paginate",
      `repos/{owner}/{repo}/issues/${pr}/timeline`,
      "--jq",
      COPILOT_EVENTS_JQ,
    ]);
    return out.split("\n").filter((line) => line.trim() !== "").length;
  }

  async listReviews(repoPath: string, pr: number): Promise<PrReview[]> {
    const out = await this.gh(repoPath, [
      "api",
      "--paginate",
      `repos/{owner}/{repo}/pulls/${pr}/reviews`,
    ]);
    const list = JSON.parse(out || "[]") as Array<{
      id: number;
      user?: { login?: string } | null;
      state: string;
      commit_id?: string | null;
      submitted_at?: string | null;
    }>;
    return list.map((r) => ({
      id: String(r.id),
      author: r.user?.login ?? "",
      state: r.state,
      commitId: r.commit_id ?? null,
      submittedAt: r.submitted_at ?? null,
    }));
  }

  /** Every review thread of the pull request, with every comment, page by page. */
  async listReviewThreads(repoPath: string, pr: number): Promise<ReviewThread[]> {
    const threads: RawThread[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${THREADS_QUERY}`,
        "-F",
        "owner={owner}",
        "-F",
        "repo={repo}",
        "-F",
        `number=${pr}`,
      ];
      if (after !== null) args.push("-f", `after=${after}`);
      const data = JSON.parse(await this.gh(repoPath, args)) as {
        data: {
          repository: {
            pullRequest: { reviewThreads: { pageInfo?: PageInfo; nodes: RawThread[] } };
          };
        };
      };
      const list = data.data.repository.pullRequest.reviewThreads;
      threads.push(...list.nodes);
      after = nextCursor(list.pageInfo);
      if (after === null) break;
    }
    const out: ReviewThread[] = [];
    for (const t of threads) {
      const comments = [...t.comments.nodes];
      let cursor = nextCursor(t.comments.pageInfo);
      for (let page = 0; cursor !== null && page < MAX_PAGES; page++) {
        const more = await this.threadComments(repoPath, t.id, cursor);
        comments.push(...more.nodes);
        cursor = nextCursor(more.pageInfo);
      }
      out.push({
        id: t.id,
        isResolved: t.isResolved,
        path: t.path,
        line: t.line,
        startLine: t.startLine,
        comments: comments.map((c) => ({
          id: c.id,
          author: c.author?.login ?? "",
          body: c.body,
          url: c.url,
        })),
      });
    }
    return out;
  }

  /** One page of a review thread's comments, after the `after` cursor. */
  private async threadComments(
    repoPath: string,
    threadId: string,
    after: string,
  ): Promise<RawCommentPage> {
    const out = await this.gh(repoPath, [
      "api",
      "graphql",
      "-f",
      `query=${THREAD_COMMENTS_QUERY}`,
      "-f",
      `id=${threadId}`,
      "-f",
      `after=${after}`,
    ]);
    const data = JSON.parse(out) as { data: { node: { comments?: RawCommentPage } | null } };
    return data.data.node?.comments ?? { nodes: [] };
  }

  async listChecks(repoPath: string, pr: number): Promise<CheckRun[]> {
    // `gh pr checks` exits 8 while checks are pending and 1 when one fails, but
    // still prints the JSON, so the exit code is not an error here.
    const result = await this.runner.run(
      "gh",
      ["pr", "checks", String(pr), "--json", "name,bucket,link,workflow"],
      { cwd: repoPath, timeoutMs: 120_000 },
    );
    const text = result.stdout.trim();
    if (text === "") {
      if (/no checks reported/i.test(result.stderr)) return [];
      if (result.exitCode !== 0)
        throw new GhError(["pr", "checks"], result.exitCode, result.stderr);
      return [];
    }
    const list = JSON.parse(text) as Array<{
      name: string;
      bucket: CheckBucket;
      link?: string;
      workflow?: string;
    }>;
    return list.map((c) => ({
      name: c.name,
      bucket: c.bucket,
      link: c.link || null,
      workflow: c.workflow || null,
    }));
  }

  async failedCheckLog(repoPath: string, check: CheckRun): Promise<string> {
    const match = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(check.link ?? "");
    if (!match?.[1]) return "";
    const args = ["run", "view", match[1], "--log-failed"];
    if (match[2]) args.push("--job", match[2]);
    return this.gh(repoPath, args, true);
  }

  async replyToThread(repoPath: string, threadId: string, body: string): Promise<void> {
    await this.gh(repoPath, [
      "api",
      "graphql",
      "-f",
      `query=${REPLY_MUTATION}`,
      "-f",
      `thread=${threadId}`,
      "-f",
      `body=${body}`,
    ]);
  }

  async listCollaborators(repoPath: string): Promise<string[] | null> {
    const result = await this.runner.run(
      "gh",
      ["api", "--paginate", "repos/{owner}/{repo}/collaborators", "--jq", ".[].login"],
      { cwd: repoPath, timeoutMs: 120_000 },
    );
    if (result.exitCode !== 0) return null;
    return result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  async resolveThread(repoPath: string, threadId: string): Promise<void> {
    await this.gh(repoPath, [
      "api",
      "graphql",
      "-f",
      `query=${RESOLVE_MUTATION}`,
      "-f",
      `thread=${threadId}`,
    ]);
  }
}
