// The review step: a build reviews its diff with one review pipeline run in
// the build worktree, through the engine build API and the mock vendor CLIs.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUNS_DIR, type RunState, type Vendor } from "@aio/contracts";
import { tempDir } from "../tmp.js";
import {
  CART_DONE,
  CART_WRONG,
  REPORT,
  buildWorld,
  cartPlan,
  type BuildWorld,
  type MockResponse,
} from "./harness.js";

/** The cart total with the planted flaw fixed: it counts each item's quantity. */
const CART_FIXED =
  "export function total(items) {\n  return items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0);\n}\n";

/** The planted flaw: `total()` ignores each item's quantity. */
const FLAW = {
  severity: "P2",
  title: "total() ignores item quantity",
  file: "src/cart.mjs",
  lines: [1, 3],
  failure_case: "A cart with one item of price 2 and quantity 3 totals 2 instead of 6.",
  category: "correctness",
  introduced: true,
};

/** The Developer's task: it writes the cart total with the planted flaw. */
const DEVELOPER: MockResponse = {
  match: "Task T1",
  output: REPORT,
  writeFiles: { "src/cart.mjs": CART_DONE },
};

/** Review answers: the first review round finds the flaw, and later reviews find nothing. */
function reviewers(fix: MockResponse): MockResponse[] {
  // The fixer's prompt names the task too, so its answer comes before the Developer's.
  return [
    { match: "Fix (these|the) confirmed findings", ...fix },
    DEVELOPER,
    { match: "Another agent fixed", output: { incomplete: [], findings: [] } },
    {
      match: "[Dd]isprove",
      output: {
        verdicts: [
          {
            id: "F-0001",
            verdict: "confirmed",
            verification: "code-reading",
            evidence: "total() adds item.price and never reads item.quantity.",
          },
        ],
        verdict: "confirmed",
        verification: "code-reading",
        evidence: "total() adds item.price and never reads item.quantity.",
      },
    },
    { match: "quantity", output: { findings: [] } },
    { times: 1, output: { findings: [FLAW] } },
    { output: { findings: [] } },
  ];
}

interface ReviewFile {
  runId: string;
}

/** Waits until the review run's state satisfies `done`. */
async function waitForRun(
  world: BuildWorld,
  runId: string,
  done: (run: RunState) => boolean,
  ms = 30_000,
): Promise<RunState> {
  const end = Date.now() + ms;
  let run = await world.runs.get(runId);
  while (Date.now() < end) {
    if (run && done(run)) return run;
    await new Promise((r) => setTimeout(r, 25));
    run = await world.runs.get(runId);
  }
  throw new Error(`run ${runId} didn't reach the state; last: ${JSON.stringify(run)}`);
}

/** The commands a review run's gate ran at its preflight. */
function gateCommands(root: string, runId: string): Array<{ kind: string; command: string }> {
  const preflight = JSON.parse(
    readFileSync(join(root, RUNS_DIR, runId, "preflight.json"), "utf8"),
  ) as { baseline: { commands: Array<{ kind: string; command: string }> } };
  return preflight.baseline.commands.map(({ kind, command }) => ({ kind, command }));
}

/** The text of a vendor's safety refusal. */
const REFUSED = "This content was flagged for possible cybersecurity risk.";

/** Review answers where every disprover refuses the finding, so it waits for a person. */
function refusingReviewers(): MockResponse[] {
  return [
    DEVELOPER,
    { match: "[Dd]isprove", error: "crash", errorMessage: REFUSED },
    { times: 1, output: { findings: [FLAW] } },
    { output: { findings: [] } },
  ];
}

describe("the review step", () => {
  it("treats a run that ends clean with follow-ups as clean and moves to release ready", async () => {
    const world = await buildWorld({ review: true });
    world.script({ claude: refusingReviewers(), codex: refusingReviewers() });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    const { runId } = JSON.parse(world.file("cart-total", "review/run.json")) as ReviewFile;
    const run = await world.runs.get(runId);
    expect(run).toMatchObject({ status: "finished", stopReason: "clean_with_followups" });
    expect(state).toMatchObject({ step: "release_ready", status: "paused" });
    expect(state.escalations).toEqual([]);
  });

  it("finds a planted flaw, has the Developer seat fix it with the task context, confirms it, and moves to release ready", async () => {
    const world = await buildWorld({ review: true });
    const fix: MockResponse = {
      output: { fixed: ["F-0001"], notFixed: [], summary: "Counted the quantity." },
      writeFiles: { "src/cart.mjs": CART_FIXED },
      commit: "fix(cart): count item quantity (F-1)",
    };
    world.script({ claude: reviewers(fix), codex: reviewers(fix) });

    const started = await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "release_ready", status: "paused" });
    expect(state.escalations).toEqual([]);
    const { runId } = JSON.parse(world.file("cart-total", "review/run.json")) as ReviewFile;
    const run = await world.runs.get(runId);
    expect(run).toMatchObject({ status: "finished", stopReason: "clean" });
    expect(run?.request).toMatchObject({
      repoPath: state.worktree,
      build: { buildId: started.id, fixer: { placement: { seat: "developer", fresh: true } } },
    });
    const findings = await world.runs.findings(runId, {});
    expect(findings).toEqual([expect.objectContaining({ title: FLAW.title, verdict: "fixed" })]);
    expect(findings[0]?.fixCommit).toBeTruthy();
    expect(world.git(world.root, "show", "build/cart-total:src/cart.mjs")).toBe(CART_FIXED.trim());

    // The fixer is a fresh Developer-seat agent with the task context in its prompt.
    const fixes = world.calls().filter((c) => /Fix (these|the) confirmed findings/.test(c.prompt));
    expect(fixes).toHaveLength(1);
    expect(fixes[0]?.prompt).toContain("Make total() return the sum of the item prices.");
    expect(fixes[0]?.prompt).toContain("The cart reports the sum of its item prices.");
    expect(fixes[0]?.argv).not.toContain("--resume");
    const fixer = world.events
      .ofType("agent.started")
      .filter((e) => e.runId === runId && e.role === "fixer");
    expect(fixer).toEqual([
      expect.objectContaining({
        buildId: started.id,
        seat: "developer",
        step: "review",
        placement: expect.objectContaining({ seat: "developer", fresh: true }),
      }),
    ]);
    // Every lease of the build's review run names the build, so it skips the ceilings.
    const runLeases = world.broker.requests.filter((r) => r.runId === runId);
    expect(runLeases.length).toBeGreaterThan(2);
    expect(runLeases.every((r) => r.buildId === started.id)).toBe(true);
  });

  it("starts its review run without a box, so no box gets a hold-edits message", async () => {
    const world = await buildWorld({ review: true });
    world.script({
      claude: [DEVELOPER, { output: { findings: [] } }],
      codex: [{ output: { findings: [] } }],
    });

    await world.start("cart-total");
    await world.settle("cart-total");

    const { runId } = JSON.parse(world.file("cart-total", "review/run.json")) as ReviewFile;
    const run = await world.runs.get(runId);
    expect(run).toMatchObject({ status: "finished", stopReason: "clean" });
    expect(run?.boxId).toBeUndefined();
    expect(run?.request.boxId).toBeUndefined();
    expect(world.events.ofType("run.changed").every((e) => e.run.boxId === undefined)).toBe(true);
  });

  it("doesn't fail the review gate on a test that the build's baseline holds as flaky", async () => {
    const world = await buildWorld({ review: true });
    // The stock test fails in the second preflight run, so the baseline holds
    // it as flaky, and it fails again once the fix counts the quantity.
    const counter = join(tempDir("aio-flaky-"), "runs");
    writeFileSync(
      join(world.root, "test", "stock.test.mjs"),
      [
        'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
        `const file = ${JSON.stringify(counter)};`,
        'const run = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1;',
        "writeFileSync(file, String(run));",
        'if (run === 2 || readFileSync("src/cart.mjs", "utf8").includes("quantity")) {',
        '  console.log("not ok - stock sync");',
        "  process.exit(1);",
        "}",
        'console.log("ok");',
        "",
      ].join("\n"),
    );
    world.git(world.root, "add", "-A");
    world.git(world.root, "commit", "-q", "-m", "test: add the stock test");
    const fix: MockResponse = {
      output: { fixed: ["F-0001"], notFixed: [], summary: "Counted the quantity." },
      writeFiles: { "src/cart.mjs": CART_FIXED },
      commit: "fix(cart): count item quantity (F-1)",
    };
    world.script({ claude: reviewers(fix), codex: reviewers(fix) });
    const plan = cartPlan();
    plan.commands.test = [...plan.commands.test, { command: "node test/stock.test.mjs" }];

    await world.start("cart-total", plan);
    const state = await world.settle("cart-total");

    expect(world.file("cart-total", "baseline.json")).toContain("not ok - stock sync");
    const { runId } = JSON.parse(world.file("cart-total", "review/run.json")) as ReviewFile;
    expect(await world.runs.get(runId)).toMatchObject({ status: "finished", stopReason: "clean" });
    expect(state).toMatchObject({ step: "release_ready", status: "paused" });
  });

  it("turns a review decision into a build escalation file", async () => {
    // The project has no policy file. The review gate runs the build plan's
    // commands, and the fix breaks the plan's test command.
    const world = await buildWorld({ review: true });
    const fix: MockResponse = {
      output: { fixed: ["F-0001"], notFixed: [], summary: "Counted the quantity." },
      writeFiles: { "src/cart.mjs": CART_WRONG },
      commit: "fix(cart): count item quantity (F-1)",
    };
    world.script({ claude: reviewers(fix), codex: reviewers(fix) });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "waiting_escalation" });
    expect(state.escalations).toEqual([
      expect.objectContaining({ id: "E1", kind: "review", file: "escalations/E1.json" }),
    ]);
    const { runId } = JSON.parse(world.file("cart-total", "review/run.json")) as ReviewFile;
    const run = await world.runs.get(runId);
    expect(run).toMatchObject({ status: "waiting_decision", decision: { kind: "gate_failed" } });
    expect(gateCommands(world.root, runId)).toEqual([
      { kind: "test", command: "node test/cart.test.mjs" },
      { kind: "typecheck", command: "node --check src/cart.mjs" },
      { kind: "lint", command: "node lint.mjs" },
    ]);
    const file = JSON.parse(world.file("cart-total", "escalations/E1.json")) as {
      step: string;
      details: string;
    };
    expect(file.step).toBe("review");
    expect(file.details).toContain(runId);
    expect(file.details).toContain("gate_failed");
  });

  it("answers the review run's decision from a resolve request, and starts a new run on a retry", async () => {
    const world = await buildWorld({ review: true });
    const fix: MockResponse = {
      output: { fixed: ["F-0001"], notFixed: [], summary: "Counted the quantity." },
      writeFiles: { "src/cart.mjs": CART_WRONG },
      commit: "fix(cart): count item quantity (F-1)",
    };
    world.script({ claude: reviewers(fix), codex: reviewers(fix) });
    await world.start("cart-total");
    await world.settle("cart-total");
    const { runId } = JSON.parse(world.file("cart-total", "review/run.json")) as ReviewFile;

    // A retry can't skip the decision the run waits for.
    await expect(
      world.manager.resolve("cart-total", { escalation: "E1", action: "retry" }),
    ).rejects.toThrow(/waits for a decision \(gate_failed\)/);
    await world.manager.resolve("cart-total", {
      escalation: "E1",
      action: "decide",
      decision: { option: "cancel" },
      note: "The fix broke the gate; start over.",
    });
    const cancelled = await world.waitFor("cart-total", (s) => s.escalations.length === 2);

    expect(await world.runs.get(runId)).toMatchObject({ status: "cancelled" });
    expect(cancelled.escalations[0]).toMatchObject({
      status: "resolved",
      runId,
      resolution: { action: "decide", decision: { option: "cancel" } },
    });
    expect(cancelled.escalations[1]).toMatchObject({ kind: "review", runId, status: "open" });

    await world.manager.resolve("cart-total", { escalation: "E2", action: "retry" });
    const state = await world.waitFor("cart-total", (s) => s.step === "release_ready");

    const next = JSON.parse(world.file("cart-total", "review/run.json")) as ReviewFile;
    expect(next.runId).not.toBe(runId);
    expect(JSON.parse(world.file("cart-total", `review/run-${runId}.json`))).toEqual({ runId });
    expect(state.escalations.map((e) => e.status)).toEqual(["resolved", "resolved"]);
  });

  it("gates with the plan's commands over the policy file's, and keeps the policy file's rules", async () => {
    const world = await buildWorld({ review: true });
    mkdirSync(join(world.root, ".aio"), { recursive: true });
    writeFileSync(
      join(world.root, ".aio", "policy.yaml"),
      [
        "version: 1",
        "rules:",
        "  - id: R-CART",
        "    text: Cart totals use integer cents.",
        "tests:",
        '  - command: node -e "process.exit(0)"',
        "lint: []",
        "",
      ].join("\n"),
    );
    const fix: MockResponse = {
      output: { fixed: ["F-0001"], notFixed: [], summary: "Counted the quantity." },
      writeFiles: { "src/cart.mjs": CART_WRONG },
      commit: "fix(cart): count item quantity (F-1)",
    };
    world.script({ claude: reviewers(fix), codex: reviewers(fix) });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "waiting_escalation" });
    const { runId } = JSON.parse(world.file("cart-total", "review/run.json")) as ReviewFile;
    const run = await world.runs.get(runId);
    expect(run).toMatchObject({ status: "waiting_decision", decision: { kind: "gate_failed" } });
    expect(gateCommands(world.root, runId).map((c) => c.command)).toEqual([
      "node test/cart.test.mjs",
      "node --check src/cart.mjs",
      "node lint.mjs",
    ]);
    const finders = world.calls().filter((c) => /Review file group/.test(c.prompt));
    expect(finders.length).toBeGreaterThan(0);
    expect(finders.every((c) => c.prompt.includes("Cart totals use integer cents."))).toBe(true);
  });

  describe("when the disprover's vendor, Copilot, reports a quota", () => {
    const fix: MockResponse = {
      output: { fixed: ["F-0001"], notFixed: [], summary: "Counted the quantity." },
      writeFiles: { "src/cart.mjs": CART_FIXED },
      commit: "fix(cart): count item quantity (F-0001)",
    };
    /** The disprover calls that reached `vendor`'s mock CLI. */
    const disproves = (world: BuildWorld, vendor: Vendor) =>
      world.calls().filter((c) => c.cli === vendor && /[Dd]isprove/.test(c.prompt));
    /** Copilot answers reviews and fails every disprover call with `quota`. */
    const copilot = (quota: MockResponse): MockResponse[] => [
      { match: "[Dd]isprove", ...quota },
      { output: { findings: [] } },
    ];

    it("with no reset time, moves the disprover role to Claude without the owner", async () => {
      const world = await buildWorld({ review: true, copilot: true });
      world.script({
        claude: reviewers(fix),
        codex: reviewers(fix),
        copilot: copilot({ error: "usage_limit" }),
      });

      await world.start("cart-total");
      const state = await world.settle("cart-total");

      expect(state).toMatchObject({ step: "release_ready", status: "paused" });
      expect(state.escalations).toEqual([]);
      expect(disproves(world, "copilot")).toHaveLength(1);
      expect(disproves(world, "claude").length).toBeGreaterThan(0);
      // The next round works the roles out from the profile again.
      expect(world.events.ofType("role.reassigned")[0]).toEqual(
        expect.objectContaining({
          role: "disprover",
          from: ["copilot"],
          to: ["claude"],
          reason: "limit",
          effectiveRound: 1,
        }),
      );
    });

    it("with a reset time, waits for the reset and moves no role", async () => {
      const world = await buildWorld({ review: true, copilot: true });
      world.script({
        claude: reviewers(fix),
        codex: reviewers(fix),
        copilot: copilot({
          error: "usage_limit",
          errorMessage: "You have exceeded your Copilot quota. Try again in 2 hours.",
        }),
      });

      await world.start("cart-total");
      await world.waitFor("cart-total", () =>
        existsSync(join(world.dir("cart-total"), "review", "run.json")),
      );
      const { runId } = JSON.parse(world.file("cart-total", "review/run.json")) as ReviewFile;
      const run = await waitForRun(world, runId, (r) => r.status === "paused");

      expect(run.pausedUntil).toBeTruthy();
      expect(disproves(world, "copilot")).toHaveLength(1);
      expect(disproves(world, "claude")).toEqual([]);
      expect(world.events.ofType("role.reassigned")).toEqual([]);
      await world.runs.cancel(runId);
    });
  });

  it("waits for the same review run after an engine restart", async () => {
    const world = await buildWorld({ review: true });
    const fix: MockResponse = {
      output: { fixed: ["F-0001"], notFixed: [], summary: "Counted the quantity." },
      writeFiles: { "src/cart.mjs": CART_FIXED },
      commit: "fix(cart): count item quantity (F-0001)",
      delayMs: 1500,
    };
    world.script({ claude: reviewers(fix), codex: reviewers(fix) });

    await world.start("cart-total");
    await world.waitFor("cart-total", () =>
      world.calls().some((c) => /Fix (these|the) confirmed findings/.test(c.prompt)),
    );
    await world.restart();
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "release_ready", status: "paused" });
    const runsDir = join(world.root, RUNS_DIR);
    expect(readdirSync(runsDir)).toHaveLength(1);
    expect(world.git(world.root, "show", "build/cart-total:src/cart.mjs")).toBe(CART_FIXED.trim());
  });
});
