// The coverage check through the engine build API: in medium and large
// builds, an agent on a vendor other than the Test engineer's reads each
// criterion with its tests one time. The Test engineer revises once for the
// gaps it reports, and the engine runs the red check and the lock again.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import { REPORT, buildWorld, cartPlan, type MockResponse } from "./harness.js";

const TEST_FILE = "test/cart.test.mjs";
const RUN_TEST = "node test/cart.test.mjs";

/** Tests for AC1 and AC2 where the AC2 test checks only the AC1 sum. */
const WEAK_TEST = [
  "// AC1: the cart reports the sum of its item prices.",
  "// AC2: the sum counts each item's quantity.",
  'import assert from "node:assert/strict";',
  'import { total } from "../src/cart.mjs";',
  "assert.equal(total([{ price: 2 }, { price: 3 }]), 5);",
  "",
].join("\n");

/** The revised tests, which check the quantity too. */
const REVISED_TEST = [
  "// AC1: the cart reports the sum of its item prices.",
  "// AC2: the sum counts each item's quantity.",
  'import assert from "node:assert/strict";',
  'import { total } from "../src/cart.mjs";',
  "assert.equal(total([{ price: 2 }, { price: 3 }]), 5);",
  "assert.equal(total([{ price: 2, quantity: 3 }]), 6);",
  "",
].join("\n");

/** A revision that passes before the code exists, so it fails the red check. */
const GREEN_REVISION = [
  "// AC1: an empty cart totals zero.",
  "// AC2: an empty cart has no quantity.",
  'import assert from "node:assert/strict";',
  'import { total } from "../src/cart.mjs";',
  "assert.equal(total([]), 0);",
  "",
].join("\n");

const CART_QUANTITY =
  "export function total(items) {\n  return items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0);\n}\n";

const TESTS = [
  { file: TEST_FILE, name: "AC1 sums the prices", criterion: "AC1", command: RUN_TEST },
  { file: TEST_FILE, name: "AC2 counts the quantity", criterion: "AC2", command: RUN_TEST },
];

function twoCriteriaPlan(size: "small" | "medium" | "large" = "medium") {
  const plan = cartPlan({
    size,
    criteria: [
      { id: "AC1", text: "The cart reports the sum of its item prices." },
      { id: "AC2", text: "The sum counts each item's quantity." },
    ],
  });
  const task = plan.tasks[0];
  if (task) task.criteria = ["AC1", "AC2"];
  return plan;
}

function testRound(match: string, content: string): MockResponse {
  return {
    match,
    output: { summary: "Wrote the tests first.", tests: TESTS },
    writeFiles: { [TEST_FILE]: content },
  };
}

function coverage(criteria: { id: string; checked: boolean; reason: string }[]): MockResponse {
  return { match: "Coverage check", output: { summary: "Read each criterion.", criteria } };
}

const AC2_GAP = coverage([
  { id: "AC1", checked: true, reason: "The test sums two prices." },
  { id: "AC2", checked: false, reason: "No assertion uses a quantity." },
]);

const ALL_CHECKED = coverage([
  { id: "AC1", checked: true, reason: "The test sums two prices." },
  { id: "AC2", checked: true, reason: "The test sums a quantity." },
]);

const DEVELOPER: MockResponse = {
  match: "Task T1",
  output: {
    ...REPORT,
    criteria: [
      { id: "AC1", met: true },
      { id: "AC2", met: true },
    ],
  },
  writeFiles: { "src/cart.mjs": CART_QUANTITY },
};

interface SavedReport {
  callKey: string;
  answer: { vendor: string };
  gaps: { criterion: string; reason: string }[];
}

interface SavedLock {
  redCheck: string;
  files: { path: string; sha256: string }[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("the coverage check", () => {
  it("runs on another vendor, reports a criterion that the tests don't check, and locks the revised tests", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [testRound("round 1 of", WEAK_TEST), testRound("coverage revision", REVISED_TEST)],
      claude: [AC2_GAP, DEVELOPER],
    });

    await world.start("cart-total", twoCriteriaPlan());
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused" });
    expect(world.events.ofType("agent.started")).toEqual([
      expect.objectContaining({ seat: "test-engineer", vendor: "codex" }),
      expect.objectContaining({
        seat: "coverage-checker",
        step: "tests_first",
        vendor: "claude",
        role: "reviewer",
      }),
      expect.objectContaining({ seat: "test-engineer", vendor: "codex" }),
      expect.objectContaining({ seat: "developer", vendor: "claude" }),
    ]);
    const report = JSON.parse(world.file("cart-total", "coverage-check.json")) as SavedReport;
    expect(report.answer.vendor).toBe("claude");
    expect(report.gaps).toEqual([{ criterion: "AC2", reason: "No assertion uses a quantity." }]);
    const revision = world.calls()[2];
    expect(revision?.cli).toBe("codex");
    expect(revision?.prompt).toMatch(/AC2/);
    expect(revision?.prompt).toMatch(/No assertion uses a quantity/);
    const lock = JSON.parse(world.file("cart-total", "test-lock.json")) as SavedLock;
    expect(lock.redCheck).toBe("tests-first/round-2.json");
    expect(lock.files).toEqual([{ path: TEST_FILE, sha256: sha256(REVISED_TEST) }]);
    expect(world.git(world.root, "show", `build/cart-total:${TEST_FILE}`)).toBe(
      REVISED_TEST.trim(),
    );
  });

  it("locks the tests without a revision when every criterion is checked", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [testRound("round 1 of", REVISED_TEST)],
      claude: [ALL_CHECKED, DEVELOPER],
    });

    await world.start("cart-total", twoCriteriaPlan("large"));
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused" });
    expect(world.calls().map((c) => c.cli)).toEqual(["codex", "claude", "claude"]);
    const report = JSON.parse(world.file("cart-total", "coverage-check.json")) as SavedReport;
    expect(report.gaps).toEqual([]);
    const lock = JSON.parse(world.file("cart-total", "test-lock.json")) as SavedLock;
    expect(lock.redCheck).toBe("tests-first/round-1.json");
  });

  it("reports a criterion that the check's answer leaves out as unchecked", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [testRound("round 1 of", WEAK_TEST), testRound("coverage revision", REVISED_TEST)],
      claude: [coverage([{ id: "AC1", checked: true, reason: "Sums two prices." }]), DEVELOPER],
    });

    await world.start("cart-total", twoCriteriaPlan());
    await world.settle("cart-total");

    const report = JSON.parse(world.file("cart-total", "coverage-check.json")) as SavedReport;
    expect(report.gaps).toEqual([
      { criterion: "AC2", reason: expect.stringMatching(/didn't report on this criterion/) },
    ]);
  });

  it("escalates when the revised tests fail the red check, and no Developer starts", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [testRound("round 1 of", WEAK_TEST), testRound("coverage revision", GREEN_REVISION)],
      claude: [AC2_GAP, DEVELOPER],
    });

    await world.start("cart-total", twoCriteriaPlan());
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "tests_first", status: "waiting_escalation" });
    expect(state.escalations).toEqual([
      expect.objectContaining({ kind: "tests_first", level: "project_manager", taskId: null }),
    ]);
    expect(world.calls().map((c) => c.cli)).toEqual(["codex", "claude", "codex"]);
    expect(world.file("cart-total", "escalations/E1.json")).toMatch(
      /passes before the code exists/,
    );
    expect(() => world.file("cart-total", "test-lock.json")).toThrow();
  });

  it("runs as a fresh agent on the same vendor with the single-vendor setting", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        testRound("round 1 of", REVISED_TEST),
        { ...ALL_CHECKED, match: "Coverage check" },
        { ...DEVELOPER, match: "Task T1" },
      ],
    });

    await world.start("cart-total", { ...twoCriteriaPlan(), singleVendor: "codex" });
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused" });
    expect(world.events.ofType("agent.started")[1]).toMatchObject({
      seat: "coverage-checker",
      vendor: "codex",
      placement: { fresh: true },
    });
  });

  it("escalates when the plan places the check on the Test engineer's vendor", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({ codex: [testRound("round 1 of", REVISED_TEST)], claude: [DEVELOPER] });

    await world.start("cart-total", {
      ...twoCriteriaPlan(),
      placements: { "coverage-checker": { vendor: "codex" } },
    });
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "tests_first", status: "waiting_escalation" });
    expect(state.escalations).toEqual([expect.objectContaining({ kind: "placement" })]);
  });

  it("moves the check to another vendor when the plan places the Test engineer on the check's default", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      claude: [testRound("round 1 of", REVISED_TEST), DEVELOPER],
      codex: [ALL_CHECKED],
    });

    await world.start("cart-total", {
      ...twoCriteriaPlan(),
      placements: { "test-engineer": { vendor: "claude" } },
    });
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused", escalations: [] });
    expect(world.calls().map((c) => c.cli)).toEqual(["claude", "codex", "claude"]);
    const checker = world.events.ofType("agent.started")[1];
    expect(checker).toMatchObject({ seat: "coverage-checker", vendor: "codex" });
    expect(checker?.placement?.note).toMatch(/requires a vendor other than claude/);
  });

  it("resumes the check's own session on its vendor for a message", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    const note = {
      tool: "send_message",
      arguments: {
        type: "question",
        to: "coverage-checker",
        toTask: "coverage-check",
        body: "Which test covers AC2?",
      },
    };
    world.script({
      claude: [testRound("round 1 of", REVISED_TEST), { ...DEVELOPER, busCalls: [note] }],
      codex: [
        { match: "Which test covers AC2?", output: { summary: "Read the message." } },
        ALL_CHECKED,
      ],
    });

    await world.start("cart-total", {
      ...twoCriteriaPlan(),
      placements: { "test-engineer": { vendor: "claude" } },
    });
    await world.settle("cart-total");

    const codex = world.calls().filter((c) => c.cli === "codex");
    // The check's first turn starts its session; every message turn resumes it.
    expect(codex.length).toBeGreaterThanOrEqual(2);
    expect(codex[0]!.resumeId).toBeNull();
    for (const call of codex.slice(1)) expect(call.resumeId).toEqual(expect.any(String));
    const registry = JSON.parse(world.file("cart-total", "sessions.json")) as {
      sessions: { seat: string; vendor: string; turns: unknown[] }[];
    };
    const checkers = registry.sessions.filter((s) => s.seat === "coverage-checker");
    expect(checkers).toEqual([expect.objectContaining({ vendor: "codex" })]);
    expect(checkers[0]!.turns.length).toBeGreaterThanOrEqual(2);
  });

  it("waits before the next step when a message without a plan task can't be delivered", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    const ask = {
      tool: "send_message",
      arguments: {
        type: "question",
        to: "coverage-checker",
        toTask: "coverage-check",
        body: "Does a quantity of zero count?",
      },
    };
    world.script({
      codex: [
        testRound("round 1 of", WEAK_TEST),
        { ...testRound("coverage revision", REVISED_TEST), busCalls: [ask] },
      ],
      claude: [{ match: "Does a quantity of zero count?", error: "crash" }, AC2_GAP, DEVELOPER],
    });

    await world.start("cart-total", twoCriteriaPlan());
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "tasks", status: "waiting_escalation" });
    expect(state.escalations).toEqual([
      expect.objectContaining({ kind: "agent_call", taskId: null, status: "open" }),
    ]);
    expect(world.events.ofType("agent.started").map((e) => e.seat)).not.toContain("developer");
  });

  it("skips the check in a small build", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({ codex: [testRound("round 1 of", REVISED_TEST)], claude: [DEVELOPER] });

    await world.start("cart-total", twoCriteriaPlan("small"));
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused" });
    expect(world.calls().map((c) => c.cli)).toEqual(["codex", "claude"]);
    expect(() => world.file("cart-total", "coverage-check.json")).toThrow();
    expect(world.file("cart-total", "test-lock.json")).toMatch(/round-1/);
  });
});
