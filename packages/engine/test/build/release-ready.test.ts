// The release ready step through the engine build API: the criteria trace,
// the Scribe, the push answer, and the push and CI loop over a local bare
// remote and a fake GitHub client.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BuildPlanInput } from "@aio/contracts";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import type {
  CheckRun,
  CreatePrInput,
  GitHubClient,
  PrInfo,
  ReviewRequestResult,
} from "../../src/postpush/github.js";
import { tempDir } from "../tmp.js";
import {
  CART_DONE,
  REPORT,
  buildWorld,
  cartPlan,
  type BuildWorld,
  type MockResponse,
} from "./harness.js";

const DEVELOPER: MockResponse = {
  match: "Task T1",
  output: REPORT,
  writeFiles: { "src/cart.mjs": CART_DONE },
};

/** Review answers that find nothing. */
const CLEAN_REVIEW: MockResponse = { output: { findings: [] } };

/** The cart total that also counts each item's quantity, which the CI check wants. */
const CART_FIXED =
  "export function total(items) {\n  return items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0);\n}\n";

/** A test for AC1 that fails on an assertion against the cart stub. */
const RED_TEST = [
  "// AC1: the cart reports the sum of its item prices.",
  'import assert from "node:assert/strict";',
  'import { total } from "../src/cart.mjs";',
  "assert.equal(total([{ price: 2 }, { price: 3 }]), 5);",
  "",
].join("\n");

/** The Test engineer's first round: the red test for AC1. */
const TEST_ENGINEER: MockResponse = {
  match: "round 1 of",
  output: {
    summary: "Wrote the tests first.",
    tests: [
      {
        file: "test/cart.test.mjs",
        name: "AC1: the cart reports the sum of its item prices",
        criterion: "AC1",
        command: "node test/cart.test.mjs",
      },
    ],
  },
  writeFiles: { "test/cart.test.mjs": RED_TEST },
};

/** The Scribe: a changelog entry, a decision record, and one file it may not change. */
const SCRIBE: MockResponse = {
  match: "Task release",
  output: {
    summary: "Recorded the cart total.",
    pullRequest: {
      title: "feat(cart): add the cart total",
      body: "Adds `total()` to the cart, so the checkout can show the sum.",
    },
    records: [
      { path: "CHANGELOG.md", kind: "changelog" },
      { path: "docs/adr/0001-cart-total.md", kind: "adr" },
    ],
  },
  writeFiles: {
    "CHANGELOG.md": "# Changelog\n\n- Add the cart total.\n",
    "docs/adr/0001-cart-total.md": "# Sum item prices in the cart\n",
    "src/cart.mjs": "// The Scribe may not change code.\n",
  },
};

/** The disprover of an imported failing check: it confirms the failure. */
const DISPROVER: MockResponse = {
  match: "[Dd]isprove",
  output: {
    verdicts: [
      {
        id: "F-0001",
        verdict: "confirmed",
        verification: "code-reading",
        evidence: "total() never reads item.quantity.",
      },
    ],
    verdict: "confirmed",
    verification: "code-reading",
    evidence: "total() never reads item.quantity.",
  },
};

/** The Developer seat's fix of the failing check. */
const FIXER: MockResponse = {
  match: "Fix (these|the) confirmed findings",
  output: { fixed: ["F-0001"], notFixed: [], summary: "Counted the quantity." },
  writeFiles: { "src/cart.mjs": CART_FIXED },
  commit: "fix(cart): count item quantity",
};

/** Every answer of a build that runs from tests first to the push and CI loop. */
function fullScript(world: BuildWorld): void {
  world.script({
    codex: [TEST_ENGINEER, SCRIBE, DISPROVER, CLEAN_REVIEW],
    claude: [FIXER, DEVELOPER, DISPROVER, CLEAN_REVIEW],
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

/** Commits `files` to the sample project's `main`, where the build starts. */
function commit(world: BuildWorld, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(world.root, path), content);
  }
  world.git(world.root, "add", "-A");
  world.git(world.root, "commit", "-q", "-m", "test: add legacy tests");
}

/** A test that fails on `name` in the runs that `failOn` lists, counting runs outside the repository. */
function flakyTest(name: string, failOn: number[]): string {
  const counter = join(tempDir("aio-flaky-"), "runs");
  return [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    `const file = ${JSON.stringify(counter)};`,
    'const run = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1;',
    "writeFileSync(file, String(run));",
    `if (${JSON.stringify(failOn)}.includes(run)) {`,
    `  console.log("not ok - ${name}");`,
    "  process.exit(1);",
    "}",
    'console.log("ok");',
    "",
  ].join("\n");
}

/**
 * Gives the sample project a local bare `origin` at `origin`, a known
 * failing test, and a flaky test.
 */
function releaseProject(world: BuildWorld, origin: string): void {
  git(world.root, "init", "-q", "--bare", origin);
  git(world.root, "remote", "add", "origin", origin);
  commit(world, {
    "test/legacy.test.mjs": 'console.log("not ok - legacy discount rounding");\nprocess.exit(1);\n',
    "test/stock.test.mjs": flakyTest("stock sync", [2]),
  });
  git(world.root, "push", "-q", "origin", "main");
}

/** A path for a bare origin repository that `releaseProject()` creates. */
function originPath(): string {
  return join(tempDir("aio-origin-"), "origin.git");
}

/** The release plan: AC1 with a test, AC2 an owner check, and the legacy and flaky tests. */
function releasePlan(push: boolean | null): BuildPlanInput {
  const plan = cartPlan({ push });
  plan.criteria = [
    ...plan.criteria,
    { id: "AC2", text: "The checkout page shows the total.", verification: "owner" },
  ];
  plan.commands = {
    ...plan.commands,
    test: [
      ...plan.commands.test,
      { command: "node test/legacy.test.mjs" },
      { command: "node test/stock.test.mjs" },
    ],
  };
  return plan;
}

/**
 * A pull request on a local bare origin. Its one check fails on the first
 * head the build pushes and passes on every later one.
 */
class FakeGitHub implements GitHubClient {
  pr: PrInfo | null = null;
  created: CreatePrInput[] = [];
  reviewRequests = 0;
  checkedHeads: string[] = [];
  private failingHead: string | null = null;

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
    this.created.push(input);
    this.pr = {
      number: 12,
      url: "https://github.example.com/example/shop/pull/12",
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
  async requestCopilotReview(): Promise<ReviewRequestResult> {
    this.reviewRequests += 1;
    return { requestedReviewers: ["Copilot"] };
  }
  async listReviews(): Promise<[]> {
    return [];
  }
  async listReviewThreads(): Promise<[]> {
    return [];
  }
  async listChecks(): Promise<CheckRun[]> {
    const head = this.head(this.pr?.headRefName ?? "");
    this.checkedHeads.push(head);
    this.failingHead ??= head;
    return [
      {
        name: "unit",
        bucket: head === this.failingHead ? "fail" : "pass",
        link: "https://github.example.com/example/shop/actions/runs/1/job/2",
        workflow: "ci",
      },
    ];
  }
  async failedCheckLog(): Promise<string> {
    return "AssertionError: total([{ price: 2, quantity: 3 }]) expected 6, got 2";
  }
  async replyToThread(): Promise<void> {}
  async resolveThread(): Promise<void> {}
  async listCollaborators(): Promise<string[]> {
    return [];
  }
}

describe("the release ready step", () => {
  it("escalates a criterion that no locked test traces to a passing test", async () => {
    const world = await buildWorld({ review: true, release: true });
    world.script({ claude: [DEVELOPER, CLEAN_REVIEW], codex: [CLEAN_REVIEW] });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "release_ready", status: "waiting_escalation" });
    expect(state.escalations).toEqual([
      expect.objectContaining({ kind: "release_ready", level: "project_manager" }),
    ]);
    const file = JSON.parse(world.file("cart-total", "escalations/E1.json")) as {
      details: string;
    };
    expect(file.details).toContain("AC1");
    expect(file.details).toMatch(/no locked test/i);
  });

  it("stops before the push without a push answer, with the owner checks and the known failing and flaky tests in the pull request description", async () => {
    const origin = originPath();
    const gh = new FakeGitHub(origin);
    const world = await buildWorld({
      steps: BUILD_PIPELINE,
      review: true,
      release: true,
      github: gh,
    });
    releaseProject(world, origin);
    fullScript(world);

    await world.start("cart-total", releasePlan(null));
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "release_ready", status: "waiting_escalation" });
    expect(state.escalations).toEqual([
      expect.objectContaining({ kind: "release_ready", level: "owner" }),
    ]);
    expect(state.escalations[0]?.summary).toMatch(/push answer/);
    expect(gh.created).toEqual([]);
    expect(git(origin, "branch", "--list", "build/*")).toBe("");

    const trace = JSON.parse(world.file("cart-total", "release/trace.json")) as {
      passed: boolean;
      criteria: { id: string; passed: boolean }[];
    };
    expect(trace).toEqual({
      passed: true,
      criteria: [expect.objectContaining({ id: "AC1", passed: true })],
    });

    // The Scribe's record is a commit on the build branch, without the file it may not change.
    expect(world.git(world.root, "show", "build/cart-total:CHANGELOG.md")).toContain(
      "Add the cart total.",
    );
    expect(world.git(world.root, "show", "build/cart-total:docs/adr/0001-cart-total.md")).toBe(
      "# Sum item prices in the cart",
    );
    expect(world.git(world.root, "show", "build/cart-total:src/cart.mjs")).toBe(CART_DONE.trim());
    expect(world.git(world.root, "log", "-1", "--format=%s", "build/cart-total")).toBe(
      "docs: record Add a total to the cart",
    );
    expect(world.events.ofType("agent.started")).toContainEqual(
      expect.objectContaining({ seat: "scribe", step: "release_ready", vendor: "codex" }),
    );

    const body = world.file("cart-total", "release/pull-request.md");
    expect(body).toContain("Adds `total()` to the cart");
    expect(body).toMatch(/## Owner checks\n\n- \[ \] AC2: The checkout page shows the total\./);
    expect(body).toMatch(
      /## Known failing tests\n[\s\S]*`node test\/legacy\.test\.mjs`: not ok - legacy discount rounding/,
    );
    expect(body).toMatch(
      /## Flaky tests\n[\s\S]*`node test\/stock\.test\.mjs`: not ok - stock sync/,
    );
    expect(body).toMatch(/## Acceptance criteria\n\n- AC1: /);
  });

  it("pushes the build branch, opens the pull request, fixes a failing check, and ends release ready with a digest", async () => {
    const origin = originPath();
    const gh = new FakeGitHub(origin);
    const world = await buildWorld({
      steps: BUILD_PIPELINE,
      review: true,
      release: true,
      github: gh,
    });
    releaseProject(world, origin);
    fullScript(world);

    await world.start("cart-total", releasePlan(true));
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "release_ready", status: "finished" });
    expect(state.escalations).toEqual([]);
    expect(gh.created).toEqual([
      expect.objectContaining({
        head: "build/cart-total",
        base: "main",
        title: "feat(cart): add the cart total",
        draft: false,
      }),
    ]);
    expect(gh.created[0]?.body).toBe(world.file("cart-total", "release/pull-request.md"));
    expect(gh.created[0]?.body).toContain("- [ ] AC2: The checkout page shows the total.");
    // The default branch never moves, and Copilot isn't asked by default.
    expect(git(origin, "rev-parse", "main")).toBe(world.git(world.root, "rev-parse", "main"));
    expect(gh.reviewRequests).toBe(0);
    // The failing check got a fix on the build branch, pushed, and the checks passed.
    expect(git(origin, "show", "build/cart-total:src/cart.mjs")).toBe(CART_FIXED.trim());
    expect(new Set(gh.checkedHeads).size).toBe(2);
    const fixer = world.events
      .ofType("agent.started")
      .filter((e) => e.role === "fixer" && e.seat === "developer" && e.step === "review");
    expect(fixer).toHaveLength(1);

    const push = JSON.parse(world.file("cart-total", "release/push.json")) as Record<
      string,
      unknown
    >;
    expect(push).toMatchObject({ prNumber: 12, stopReason: "pr_clean" });
    const digest = world.file("cart-total", "digests/release-ready.md");
    expect(digest).toContain("https://github.example.com/example/shop/pull/12");
    expect(digest).toContain("AC2");
    expect(state.note).toContain("digests/release-ready.md");
    expect(world.file("cart-total", "STATUS.md")).toContain("digests/release-ready.md");
  });
});
