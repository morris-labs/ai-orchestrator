// The release ready step through the engine build API: the criteria trace,
// the Scribe, the push answer, and the push and CI loop over a local bare
// remote and a fake GitHub client.
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BuildPlanInput } from "@aio/contracts";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import { BuildWorktree } from "../../src/build/worktree.js";
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
function releaseProject(
  world: BuildWorld,
  origin: string,
  extra: Record<string, string> = {},
): void {
  git(world.root, "init", "-q", "--bare", origin);
  git(world.root, "remote", "add", "origin", origin);
  commit(world, {
    "test/legacy.test.mjs": 'console.log("not ok - legacy discount rounding");\nprocess.exit(1);\n',
    "test/stock.test.mjs": flakyTest("stock sync", [2]),
    ...extra,
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
  /** Runs after each pull request the fake creates. */
  onCreate: (() => void) | null = null;
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
    this.onCreate?.();
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

describe("the release ready step's Scribe", () => {
  it("keeps a commit that lands on the branch before the Scribe's turn starts", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE, review: true, release: true });
    world.script({
      codex: [
        TEST_ENGINEER,
        { match: "Task release", times: 2, error: "crash" },
        SCRIBE,
        CLEAN_REVIEW,
      ],
      claude: [DEVELOPER, CLEAN_REVIEW],
    });

    await world.start("cart-total", cartPlan({ push: false }));
    const waiting = await world.settle("cart-total");
    expect(waiting).toMatchObject({ step: "release_ready", status: "waiting_escalation" });
    const escalation = waiting.escalations.find((e) => e.status === "open");
    expect(escalation).toMatchObject({ kind: "agent_call" });

    // Another seat's message turn commits while the Scribe waits for its seat.
    const tree = BuildWorktree.pathFor(world.root, "cart-total");
    writeFileSync(join(tree, "NOTES.md"), "An answer from another seat.\n");
    git(tree, "add", "NOTES.md");
    git(tree, "commit", "-q", "-m", "docs: answer another seat");

    await world.manager.resolve("cart-total", { escalation: escalation!.id, action: "retry" });
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "release_ready", status: "finished" });
    expect(git(world.root, "show", "build/cart-total:NOTES.md").trim()).toBe(
      "An answer from another seat.",
    );
    expect(git(world.root, "show", "build/cart-total:CHANGELOG.md")).toContain(
      "Add the cart total.",
    );
    expect(git(world.root, "show", "build/cart-total:src/cart.mjs")).not.toContain(
      "The Scribe may not change code.",
    );
  });
});

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

  it("traces a criterion to its locked test run in the environment of the plan's test commands", async () => {
    // The test fails on a load error unless the plan's assignment is set, as a
    // native module does under the wrong Node.js.
    const envTest = [
      "// AC1: the cart reports the sum of its item prices.",
      'if (process.env.CART_ENV !== "gate") {',
      '  console.error("Error: compiled against a different Node.js version using NODE_MODULE_VERSION 127");',
      "  process.exit(1);",
      "}",
      RED_TEST,
    ].join("\n");
    const world = await buildWorld({ steps: BUILD_PIPELINE, review: true, release: true });
    world.script({
      codex: [
        { ...TEST_ENGINEER, writeFiles: { "test/cart.test.mjs": envTest } },
        SCRIBE,
        CLEAN_REVIEW,
      ],
      claude: [DEVELOPER, CLEAN_REVIEW],
    });
    const plan = cartPlan({ push: null });
    plan.commands = {
      ...plan.commands,
      test: [{ command: "CART_ENV=gate node test/cart.test.mjs" }],
    };

    await world.start("cart-total", plan);
    const state = await world.settle("cart-total");

    const [round] = world.jsonFiles("cart-total", "tests-first") as {
      check?: { passed: boolean; tests: { command: string; outcome: string }[] };
    }[];
    expect(round?.check).toMatchObject({
      passed: true,
      tests: [{ command: "node test/cart.test.mjs", outcome: "failed" }],
    });
    const trace = JSON.parse(world.file("cart-total", "release/trace.json")) as unknown;
    expect(trace).toEqual({
      passed: true,
      criteria: [expect.objectContaining({ id: "AC1", passed: true })],
    });
    expect(state.escalations[0]?.summary).toMatch(/push answer/);
    // The Test engineer learns how the engine runs its commands.
    expect(world.calls()[0]?.prompt).toContain("with `CART_ENV=gate` in front");
  });

  it("escalates a criterion whose locked test passes without running a test", async () => {
    // Red before the code exists; once it does, the command reports no tests and exits 0.
    const command =
      'node test/cart.test.mjs; s=$?; grep -q reduce src/cart.mjs && echo "No tests found"; exit $s';
    const world = await buildWorld({ steps: BUILD_PIPELINE, review: true, release: true });
    world.script({
      codex: [
        {
          ...TEST_ENGINEER,
          output: {
            summary: "Wrote the tests first.",
            tests: [
              {
                file: "test/cart.test.mjs",
                name: "AC1: the cart reports the sum of its item prices",
                criterion: "AC1",
                command,
              },
            ],
          },
        },
        CLEAN_REVIEW,
      ],
      claude: [DEVELOPER, CLEAN_REVIEW],
    });

    await world.start("cart-total", cartPlan({ push: null }));
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "release_ready", status: "waiting_escalation" });
    expect(state.escalations).toEqual([
      expect.objectContaining({ kind: "release_ready", level: "project_manager" }),
    ]);
    expect(state.escalations[0]?.summary).toContain("AC1");
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

  it("records the owner's push answer from a resolve request and ends with the branch local", async () => {
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
    await world.settle("cart-total");

    // The push answer is the owner's.
    await expect(
      world.manager.resolve("cart-total", { escalation: "E1", action: "retry", push: false }),
    ).rejects.toThrow(/waits for the owner/);
    await expect(
      world.manager.resolve("cart-total", { escalation: "E1", action: "retry", by: "owner" }),
    ).rejects.toThrow(/no push answer/);
    await world.manager.resolve("cart-total", {
      escalation: "E1",
      action: "retry",
      by: "owner",
      push: false,
    });
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ status: "finished", step: "release_ready" });
    expect(JSON.parse(world.file("cart-total", "plan.json"))).toMatchObject({ push: false });
    expect(state.escalations[0]).toMatchObject({
      status: "resolved",
      resolution: { by: "owner", push: false },
    });
    expect(world.file("cart-total", "digests/release-ready.md")).toMatch(/stays local/);
    expect(world.file("cart-total", "digests/release-ready.md")).toContain(
      "- Project manager session since planning started (tokens only): 0 turns, 0 tokens in, 0 tokens out.",
    );
    // The Project manager gets a pointer to the digest, and the push answer's escalation is answered.
    const inbox = await world.manager.inbox("cart-total", { all: true });
    expect(inbox.items.map((i) => [i.kind, i.ref])).toEqual([
      ["digest", "milestone-all"],
      ["escalation", "E1"],
      ["digest", "release-ready"],
    ]);
    expect(inbox.items[1]?.answeredAt).not.toBeNull();
    expect(inbox.items[2]?.pointer).toMatch(/release ready.* Read .*digests\/release-ready\.md$/);
    expect(gh.created).toEqual([]);
    expect(git(origin, "branch", "--list", "build/*")).toBe("");
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

  /** A world whose first push run is cancelled as soon as it opens the pull request. */
  async function cancelledPush() {
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
    const runOf = () =>
      (JSON.parse(world.file("cart-total", "review/run.json")) as { runId: string }).runId;
    gh.onCreate = () => {
      gh.onCreate = null;
      const runId = runOf();
      setTimeout(() => void world.runs.cancel(runId), 0);
    };
    await world.start("cart-total", releasePlan(true));
    const waiting = await world.settle("cart-total");
    expect(waiting.status).toBe("waiting_escalation");
    expect(waiting.escalations).toEqual([
      expect.objectContaining({ id: "E1", kind: "release_ready", status: "open" }),
    ]);
    expect(waiting.escalations[0]!.summary).toMatch(/cancelled/);
    return { world, gh, first: runOf() };
  }

  it("starts a new review run that pushes again when a retry resolves a cancelled push run's escalation", async () => {
    const { world, first } = await cancelledPush();

    await world.manager.resolve("cart-total", { escalation: "E1", action: "retry" });
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "release_ready", status: "finished" });
    expect(state.escalations).toHaveLength(1);
    const second = (JSON.parse(world.file("cart-total", "review/run.json")) as { runId: string })
      .runId;
    expect(second).not.toBe(first);
    expect(JSON.parse(world.file("cart-total", `review/run-${first}.json`))).toEqual({
      runId: first,
    });
    expect(JSON.parse(world.file("cart-total", "release/push.json"))).toMatchObject({
      runId: second,
      stopReason: "pr_clean",
    });
  });

  it("starts the build's review run again when its state is gone, instead of escalating again", async () => {
    const { world, first } = await cancelledPush();
    // The run manager no longer knows the run, such as after its state was pruned.
    await world.restart();
    rmSync(join(world.root, ".aio", "runs", first), { recursive: true, force: true });
    await world.restart();

    await world.manager.resolve("cart-total", { escalation: "E1", action: "retry" });
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "release_ready", status: "finished" });
    expect(state.escalations).toHaveLength(1);
    expect(JSON.parse(world.file("cart-total", "release/push.json"))).toMatchObject({
      stopReason: "pr_clean",
    });
  });

  it("runs the plan's full test, type check, and lint commands after the Scribe and escalates a failure before the push", async () => {
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
    // A lint check that the Scribe's changelog entry breaks: every earlier gate passes it.
    const plan = releasePlan(true);
    plan.commands.lint = [...(plan.commands.lint ?? []), { command: "test ! -f CHANGELOG.md" }];

    await world.start("cart-total", plan);
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "release_ready", status: "waiting_escalation" });
    expect(state.escalations).toEqual([
      expect.objectContaining({ kind: "release_ready", level: "project_manager" }),
    ]);
    expect(state.escalations[0]?.summary).toMatch(/final gate/i);
    const file = JSON.parse(world.file("cart-total", "escalations/E1.json")) as {
      details: string;
    };
    expect(file.details).toContain("test ! -f CHANGELOG.md");
    expect(gh.created).toEqual([]);
    expect(git(origin, "branch", "--list", "build/*")).toBe("");
  });

  it("leaves a known failing test that the build fixed out of the pull request's known failing list", async () => {
    const origin = originPath();
    const world = await buildWorld({
      steps: BUILD_PIPELINE,
      review: true,
      release: true,
      github: new FakeGitHub(origin),
    });
    // A legacy test that fails on the cart stub at the base and passes once the build adds the total.
    releaseProject(world, origin, {
      "test/legacy-sum.test.mjs": [
        'import { total } from "../src/cart.mjs";',
        "if (total([{ price: 1 }]) !== 1) {",
        '  console.log("not ok - legacy cart sum");',
        "  process.exit(1);",
        "}",
        'console.log("ok");',
        "",
      ].join("\n"),
    });
    fullScript(world);
    const plan = releasePlan(false);
    plan.commands.test = [...plan.commands.test, { command: "node test/legacy-sum.test.mjs" }];

    await world.start("cart-total", plan);
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "release_ready", status: "finished" });
    const baseline = world.file("cart-total", "baseline.json");
    expect(baseline).toContain("not ok - legacy cart sum");
    const body = world.file("cart-total", "release/pull-request.md");
    const known = body.slice(
      body.indexOf("## Known failing tests"),
      body.indexOf("## Flaky tests"),
    );
    expect(known).toContain("not ok - legacy discount rounding");
    expect(known).not.toContain("legacy cart sum");
    expect(body).toMatch(
      /## Fixed tests\n[\s\S]*`node test\/legacy-sum\.test\.mjs`: not ok - legacy cart sum/,
    );
    expect(world.file("cart-total", "digests/release-ready.md")).toContain(
      "Known failing tests: 1.",
    );
  });

  it("lists the confirmed nits that the review run leaves unfixed in the pull request and the digest", async () => {
    const origin = originPath();
    const world = await buildWorld({
      steps: BUILD_PIPELINE,
      review: true,
      release: true,
      github: new FakeGitHub(origin),
    });
    releaseProject(world, origin);
    const finder: MockResponse = {
      times: 1,
      output: {
        findings: [
          {
            severity: "P2",
            title: "Remove the task note from the cart",
            file: "src/cart.mjs",
            lines: [1, 1],
            failure_case: "The module keeps a development note.",
            category: "maintainability",
            introduced: true,
          },
        ],
      },
    };
    // The disprover confirms the finding and ranks it a nit.
    const nit: MockResponse = {
      match: "[Dd]isprove",
      output: {
        verdicts: [
          {
            id: "F-0001",
            verdict: "confirmed",
            severity: "nit",
            verification: "code-reading",
            evidence: "A comment only.",
          },
        ],
      },
    };
    world.script({
      codex: [TEST_ENGINEER, SCRIBE, nit, finder, CLEAN_REVIEW],
      claude: [DEVELOPER, nit, finder, CLEAN_REVIEW],
    });

    await world.start("cart-total", releasePlan(false));
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "release_ready", status: "finished" });
    const body = world.file("cart-total", "release/pull-request.md");
    expect(body).toMatch(
      /## Review nits\n[\s\S]*- \[ \] F-0001 `src\/cart\.mjs:1-1`: Remove the task note from the cart/,
    );
    expect(world.file("cart-total", "digests/release-ready.md")).toContain(
      "Confirmed review nits left unfixed: F-0001.",
    );
  });

  it("lists the review run's follow-up findings in the pull request when the run ended clean with follow-ups", async () => {
    const origin = originPath();
    const world = await buildWorld({
      steps: BUILD_PIPELINE,
      review: true,
      release: true,
      github: new FakeGitHub(origin),
    });
    releaseProject(world, origin);
    const refused: MockResponse = {
      match: "[Dd]isprove",
      error: "crash",
      errorMessage: "This content was flagged for possible cybersecurity risk.",
    };
    const finder: MockResponse = {
      times: 1,
      output: {
        findings: [
          {
            severity: "P2",
            title: "total() ignores item quantity",
            file: "src/cart.mjs",
            lines: [1, 3],
            failure_case: "A cart with one item of price 2 and quantity 3 totals 2 instead of 6.",
            category: "correctness",
            introduced: true,
          },
        ],
      },
    };
    world.script({
      codex: [TEST_ENGINEER, SCRIBE, refused, finder, CLEAN_REVIEW],
      claude: [DEVELOPER, refused, finder, CLEAN_REVIEW],
    });

    await world.start("cart-total", releasePlan(false));
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "release_ready", status: "finished" });
    const body = world.file("cart-total", "release/pull-request.md");
    expect(body).toMatch(
      /## Review follow-ups\n[\s\S]*- \[ \] F-\d{4} \(P2\) `src\/cart\.mjs:1-3`: total\(\) ignores item quantity/,
    );
    expect(body).toMatch(/## Review follow-ups[\s\S]*cybersecurity/);
  });
});
