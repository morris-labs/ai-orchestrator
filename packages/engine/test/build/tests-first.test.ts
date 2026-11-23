// Tests first through the engine build API: the Test engineer writes the
// tests, the engine runs the red check and locks them, and the task gate
// holds the Developer to the lock.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import { CART_DONE, REPORT, buildWorld, cartPlan, type MockResponse } from "./harness.js";

/** A test for AC1 that fails on an assertion against the cart stub. */
const RED_TEST = [
  "// AC1: the cart reports the sum of its item prices.",
  'import assert from "node:assert/strict";',
  'import { total } from "../src/cart.mjs";',
  "assert.equal(total([{ price: 2 }, { price: 3 }]), 5);",
  "",
].join("\n");

/** A test for AC1 that passes against the stub, before the code exists. */
const GREEN_TEST = [
  "// AC1: an empty cart totals zero.",
  'import assert from "node:assert/strict";',
  'import { total } from "../src/cart.mjs";',
  "assert.equal(total([]), 0);",
  "",
].join("\n");

/** A test for AC1 that fails on its import, not on an assertion. */
const IMPORT_ERROR_TEST = [
  "// AC1: the cart reports the sum of its item prices.",
  'import assert from "node:assert/strict";',
  'import { sum } from "../src/cart.mjs";',
  "assert.equal(sum([{ price: 2 }, { price: 3 }]), 5);",
  "",
].join("\n");

const TEST_FILE = "test/cart.test.mjs";
const RUN_TEST = "node test/cart.test.mjs";

interface TestEntry {
  file?: string;
  name?: string;
  criterion?: string;
  command?: string;
}

const AC1_TEST: TestEntry = {
  file: TEST_FILE,
  name: "AC1: the cart reports the sum of its item prices",
  criterion: "AC1",
  command: RUN_TEST,
};

/** A Test engineer answer for round `round` that writes `content` and lists `tests`. */
function testRound(round: number, content: string, tests: TestEntry[] = [AC1_TEST]): MockResponse {
  return {
    match: `round ${round} of`,
    output: { summary: "Wrote the tests first.", tests },
    writeFiles: { [TEST_FILE]: content },
  };
}

const DEVELOPER: MockResponse = {
  match: "Task T1",
  output: REPORT,
  writeFiles: { "src/cart.mjs": CART_DONE },
};

interface SavedRound {
  check?: {
    passed: boolean;
    problems: string[];
    tests: { file: string; criterion: string; outcome: string }[];
  };
}

interface SavedLock {
  commit: string;
  redCheck: string;
  files: { path: string; sha256: string }[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("tests first", () => {
  it("writes one failing test for a small build, records the red check, and locks the test", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({ codex: [testRound(1, RED_TEST)], claude: [DEVELOPER] });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused" });
    expect(world.calls().map((c) => c.cli)).toEqual(["codex", "claude"]);
    expect(world.events.ofType("agent.started")).toEqual([
      expect.objectContaining({ seat: "test-engineer", step: "tests_first", vendor: "codex" }),
      expect.objectContaining({ seat: "developer", step: "tasks", vendor: "claude" }),
    ]);
    const [round] = world.jsonFiles("cart-total", "tests-first") as SavedRound[];
    expect(round?.check).toMatchObject({
      passed: true,
      problems: [],
      tests: [{ file: TEST_FILE, criterion: "AC1", outcome: "failed" }],
    });
    const lock = JSON.parse(world.file("cart-total", "test-lock.json")) as SavedLock;
    expect(lock.redCheck).toBe("tests-first/round-1.json");
    expect(lock.files).toEqual([{ path: TEST_FILE, sha256: sha256(RED_TEST) }]);
    expect(world.git(world.root, "show", `${lock.commit}:${TEST_FILE}`)).toBe(RED_TEST.trim());
    expect(world.git(world.root, "show", `build/cart-total:${TEST_FILE}`)).toBe(RED_TEST.trim());
    expect(world.git(world.root, "rev-list", "--count", "main..build/cart-total")).toBe("2");
  });
});
