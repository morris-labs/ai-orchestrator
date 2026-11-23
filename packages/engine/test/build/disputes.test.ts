// Test disputes through the engine build API: a Developer that believes a
// locked test is wrong disputes it in its report. The Test engineer amends
// the test or rejects the dispute, the Project manager rules on repeated
// disputes, and the owner decides an amendment that changes a criterion.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import { CART_DONE, REPORT, buildWorld, type MockResponse } from "./harness.js";

const TEST_FILE = "test/cart.test.mjs";
const RUN_TEST = "node test/cart.test.mjs";

/** A wrong test for AC1: it wants double the sum, so no right code passes it. */
const WRONG_TEST = [
  "// AC1: the cart reports the sum of its item prices.",
  'import assert from "node:assert/strict";',
  'import { total } from "../src/cart.mjs";',
  "assert.equal(total([{ price: 2 }, { price: 3 }]), 10);",
  "",
].join("\n");

/** The right test for AC1, which fails on an assertion against the stub. */
const RIGHT_TEST = [
  "// AC1: the cart reports the sum of its item prices.",
  'import assert from "node:assert/strict";',
  'import { total } from "../src/cart.mjs";',
  "assert.equal(total([{ price: 2 }, { price: 3 }]), 5);",
  "",
].join("\n");

/** A test for AC1 that passes against the stub, so it fails the red check. */
const GREEN_TEST = [
  "// AC1: an empty cart totals zero.",
  'import assert from "node:assert/strict";',
  'import { total } from "../src/cart.mjs";',
  "assert.equal(total([]), 0);",
  "",
].join("\n");

const AC1_TEST = {
  file: TEST_FILE,
  name: "AC1: the cart reports the sum of its item prices",
  criterion: "AC1",
  command: RUN_TEST,
};

/** The Test engineer's tests first round, which locks `content`. */
function testsFirst(content: string): MockResponse {
  return {
    match: "round 1 of",
    output: { summary: "Wrote the tests first.", tests: [AC1_TEST] },
    writeFiles: { [TEST_FILE]: content },
  };
}

const DISPUTE_REASON = "AC1 asks for the sum of the prices, 5, but the test wants 10.";

/** A Developer answer that writes the right code and disputes the locked test. */
function disputing(match: string): MockResponse {
  return {
    match,
    output: { ...REPORT, dispute: { test: TEST_FILE, reason: DISPUTE_REASON } },
    writeFiles: { "src/cart.mjs": CART_DONE },
  };
}

/** A Developer answer that writes the right code and reports no dispute. */
function finishing(match: string): MockResponse {
  return { match, output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } };
}

/** The Test engineer's answer to a dispute. */
function verdict(
  answer: { verdict: "amend" | "reject"; reason: string; changesCriterion?: boolean },
  content?: string,
): MockResponse {
  return {
    match: "test dispute",
    output: { changesCriterion: false, ...answer },
    ...(content !== undefined ? { writeFiles: { [TEST_FILE]: content } } : {}),
  };
}

interface SavedDispute {
  id: number;
  taskId: string;
  test: string;
  reason: string;
  outcome?: string;
  note?: string;
  escalation?: string;
  check?: { passed: boolean; tests: { outcome: string }[] };
}

interface SavedLock {
  commit: string;
  files: { path: string; sha256: string }[];
  amendments?: { taskId: string; test: string; reason: string; dispute: string; commit: string }[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function dispute(world: Awaited<ReturnType<typeof buildWorld>>, n: number): SavedDispute {
  return JSON.parse(world.file("cart-total", `tasks/T1/dispute-${n}.json`)) as SavedDispute;
}

function lockOf(world: Awaited<ReturnType<typeof buildWorld>>): SavedLock {
  return JSON.parse(world.file("cart-total", "test-lock.json")) as SavedLock;
}

describe("a test dispute", () => {
  it("ends amended for a wrong test: the fixed test passes the red check and is locked again, and the attempt doesn't count", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        testsFirst(WRONG_TEST),
        verdict({ verdict: "amend", reason: "The test wanted double the sum." }, RIGHT_TEST),
      ],
      claude: [finishing("test dispute 1 .*amended"), disputing("attempt 1 of")],
    });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused" });
    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(state.escalations).toEqual([]);
    expect(world.calls().map((c) => c.cli)).toEqual(["codex", "claude", "codex", "claude"]);
    expect(world.calls()[2]?.prompt).toContain(DISPUTE_REASON);
    expect(dispute(world, 1)).toMatchObject({
      id: 1,
      taskId: "T1",
      test: TEST_FILE,
      reason: DISPUTE_REASON,
      outcome: "amended",
      check: { passed: true, tests: [{ outcome: "failed" }] },
    });
    const lock = lockOf(world);
    expect(lock.files).toEqual([{ path: TEST_FILE, sha256: sha256(RIGHT_TEST) }]);
    expect(lock.amendments).toEqual([
      expect.objectContaining({
        taskId: "T1",
        test: TEST_FILE,
        reason: "The test wanted double the sum.",
        dispute: "tasks/T1/dispute-1.json",
        commit: lock.commit,
      }),
    ]);
    expect(world.git(world.root, "show", `${lock.commit}:${TEST_FILE}`)).toBe(RIGHT_TEST.trim());
    expect(world.git(world.root, "show", `build/cart-total:${TEST_FILE}`)).toBe(
      RIGHT_TEST.trim(),
    );
    expect(world.git(world.root, "show", "build/cart-total:src/cart.mjs")).toBe(CART_DONE.trim());
  });
});
