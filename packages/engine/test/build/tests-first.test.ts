// Tests first through the engine build API: the Test engineer writes the
// tests, the engine runs the red check and locks them, and the task gate
// holds the Developer to the lock.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import {
  CART_DONE,
  CART_STUB,
  REPORT,
  buildWorld,
  cartPlan,
  type MockResponse,
} from "./harness.js";

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
      expect.objectContaining({
        seat: "test-engineer",
        step: "tests_first",
        vendor: "codex",
        role: "fixer",
      }),
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

describe("tests first at a path with brackets", () => {
  it("keeps the Test engineer's test at that exact path and locks it", async () => {
    const file = "test/[cart]/total.test.mjs";
    const content = RED_TEST.replace("../src/cart.mjs", "../../src/cart.mjs");
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        {
          match: "round 1 of",
          output: {
            summary: "Wrote the tests first.",
            tests: [{ ...AC1_TEST, file, command: `node '${file}'` }],
          },
          writeFiles: { [file]: content },
        },
      ],
      claude: [DEVELOPER],
    });
    const plan = cartPlan();
    plan.tasks = plan.tasks.map((t) => ({ ...t, tests: [file] }));
    plan.commands = { ...plan.commands, test: [{ command: `node '${file}'` }] };

    await world.start("cart-total", plan);
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused" });
    const lock = JSON.parse(world.file("cart-total", "test-lock.json")) as SavedLock;
    expect(lock.files).toEqual([{ path: file, sha256: sha256(content) }]);
    expect(world.git(world.root, "show", `build/cart-total:${file}`)).toBe(content.trim());
  });
});

describe("the red check", () => {
  it.each([
    ["passes before the code exists", GREEN_TEST, /passes before the code exists/],
    ["fails on an import error", IMPORT_ERROR_TEST, /failed on an error: SyntaxError/],
  ])("sends back a test that %s", async (_label, content, problem) => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [testRound(1, content), testRound(2, RED_TEST)],
      claude: [DEVELOPER],
    });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused" });
    const [first, second] = world.jsonFiles("cart-total", "tests-first") as SavedRound[];
    expect(first?.check?.passed).toBe(false);
    expect(first?.check?.problems).toEqual([expect.stringMatching(problem)]);
    expect(second?.check?.passed).toBe(true);
    const retry = world.calls()[1];
    expect(retry?.cli).toBe("codex");
    expect(retry?.prompt).toMatch(problem);
    const lock = JSON.parse(world.file("cart-total", "test-lock.json")) as SavedLock;
    expect(lock.redCheck).toBe("tests-first/round-2.json");
    expect(lock.files).toEqual([{ path: TEST_FILE, sha256: sha256(RED_TEST) }]);
  });

  it("sends back tests that fail the plan's lint command", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    const unlinted = RED_TEST.replace("assert.equal(", "var unused = 1;\nassert.equal(");
    world.script({
      codex: [testRound(1, unlinted), testRound(2, RED_TEST)],
      claude: [DEVELOPER],
    });
    const plan = cartPlan({
      commands: {
        ...cartPlan().commands,
        lint: [{ command: "node lint.mjs" }, { command: `! grep -n "var " ${TEST_FILE}` }],
      },
    });

    await world.start("cart-total", plan);
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused" });
    const [first, second] = world.jsonFiles("cart-total", "tests-first") as SavedRound[];
    expect(first?.check?.problems).toEqual([
      expect.stringMatching(
        /lint command `! grep -n "var " test\/cart\.test\.mjs` fails[\s\S]*var unused/,
      ),
    ]);
    expect(second?.check?.passed).toBe(true);
    expect(world.calls()[1]?.prompt).toMatch(/lint command .* fails with the tests in place/);
  });

  it("sends back a test in a file of a task that doesn't cover its criterion", async () => {
    const otherFile = "test/one-item.test.mjs";
    const both = `${RED_TEST}// AC2: one item totals its price.\n`;
    const ac2Test: TestEntry = {
      file: TEST_FILE,
      name: "AC2: one item totals its price",
      criterion: "AC2",
      command: RUN_TEST,
    };
    const ac2Red = [
      "// AC2: one item totals its price.",
      'import assert from "node:assert/strict";',
      'import { total } from "../src/cart.mjs";',
      "assert.equal(total([{ price: 4 }]), 4);",
      "",
    ].join("\n");
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        testRound(1, both, [AC1_TEST, ac2Test]),
        {
          match: "round 2 of",
          output: {
            summary: "Moved the AC2 test.",
            tests: [AC1_TEST, { ...ac2Test, file: otherFile, command: `node ${otherFile}` }],
          },
          writeFiles: { [TEST_FILE]: RED_TEST, [otherFile]: ac2Red },
        },
      ],
      claude: [DEVELOPER],
    });
    const base = cartPlan();
    const plan = cartPlan({
      criteria: [
        { id: "AC1", text: "The cart reports the sum of its item prices." },
        { id: "AC2", text: "One item totals its price." },
      ],
      tasks: [
        ...base.tasks,
        {
          id: "T2",
          title: "One-item total",
          description: "Check the total of one item.",
          ownedFiles: ["src/one-item.mjs"],
          criteria: ["AC2"],
          tests: [otherFile],
        },
      ],
    });

    await world.start("cart-total", plan);
    await world.settle("cart-total");

    const [first, second] = world.jsonFiles("cart-total", "tests-first") as SavedRound[];
    expect(first?.check?.problems).toEqual([
      expect.stringMatching(
        /checks criterion AC2, but test\/cart\.test\.mjs belongs to task T1, which covers AC1\. .*test\/one-item\.test\.mjs/,
      ),
      "Criterion AC2 has no test.",
    ]);
    expect(second?.check?.passed).toBe(true);
    expect(world.calls()[1]?.prompt).toMatch(/That task can't make it pass/);
  });

  it("sends back a test without a criterion ID", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    const { criterion: _dropped, ...unnamed } = AC1_TEST;
    world.script({
      codex: [testRound(1, RED_TEST, [unnamed]), testRound(2, RED_TEST)],
      claude: [DEVELOPER],
    });

    await world.start("cart-total");
    await world.settle("cart-total");

    const [first, second] = world.jsonFiles("cart-total", "tests-first") as SavedRound[];
    expect(first?.check?.problems).toEqual([
      expect.stringMatching(/names no criterion ID/),
      "Criterion AC1 has no test.",
    ]);
    expect(second?.check?.passed).toBe(true);
    expect(world.calls()[1]?.prompt).toMatch(/names no criterion ID/);
  });

  it("accepts a passing test for a criterion that the plan marks as one that already holds", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({ codex: [testRound(1, GREEN_TEST)], claude: [DEVELOPER] });
    const plan = cartPlan({
      criteria: [{ id: "AC1", text: "An empty cart totals zero.", alreadyHolds: true }],
    });

    await world.start("cart-total", plan);
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused" });
    const [round] = world.jsonFiles("cart-total", "tests-first") as SavedRound[];
    expect(round?.check).toMatchObject({
      passed: true,
      tests: [{ criterion: "AC1", outcome: "passed" }],
    });
  });

  it("puts back a file that the Test engineer changed outside the test paths", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    const outside = testRound(1, RED_TEST);
    outside.writeFiles = { ...outside.writeFiles, "src/cart.mjs": CART_DONE };
    world.script({ codex: [outside, testRound(2, RED_TEST)], claude: [DEVELOPER] });

    await world.start("cart-total");
    await world.settle("cart-total");

    const [first] = world.jsonFiles("cart-total", "tests-first") as SavedRound[];
    expect(first?.check?.problems).toEqual([
      expect.stringMatching(/outside the test paths.*src\/cart\.mjs/),
    ]);
    const lock = JSON.parse(world.file("cart-total", "test-lock.json")) as SavedLock;
    expect(world.git(world.root, "show", `${lock.commit}:src/cart.mjs`)).toBe(CART_STUB.trim());
  });

  it("escalates when the tests fail the checks in every round, and no Developer starts", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({ codex: [{ ...testRound(1, GREEN_TEST), match: "round" }] });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "tests_first", status: "waiting_escalation" });
    expect(state.escalations).toEqual([
      expect.objectContaining({ kind: "tests_first", level: "project_manager", taskId: null }),
    ]);
    expect(world.calls().map((c) => c.cli)).toEqual(["codex", "codex", "codex"]);
    expect(world.file("cart-total", "escalations/E1.json")).toMatch(
      /passes before the code exists/,
    );
    expect(() => world.file("cart-total", "test-lock.json")).toThrow();
  });
});

describe("a tests first round that waits for the Test engineer", () => {
  it("keeps a commit that lands on the branch before the Test engineer's turn starts", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [{ match: "round 1 of", times: 2, error: "crash" }, testRound(1, RED_TEST)],
      claude: [DEVELOPER],
    });

    await world.start("cart-total");
    const waiting = await world.settle("cart-total");
    expect(waiting).toMatchObject({ step: "tests_first", status: "waiting_escalation" });
    const escalation = waiting.escalations.find((e) => e.status === "open");
    expect(escalation).toMatchObject({ kind: "agent_call" });

    // Another seat's message turn commits while the round waits for the seat.
    writeFileSync(join(waiting.worktree, "NOTES.md"), "An answer from another seat.\n");
    world.git(waiting.worktree, "add", "NOTES.md");
    world.git(waiting.worktree, "commit", "-q", "-m", "docs: answer another seat");

    await world.manager.resolve("cart-total", { escalation: escalation!.id, action: "retry" });
    const state = await world.waitFor("cart-total", (s) => s.step === "review");

    const [round] = world.jsonFiles("cart-total", "tests-first") as SavedRound[];
    expect(round?.check).toMatchObject({ passed: true, problems: [] });
    expect(world.git(world.root, "show", "build/cart-total:NOTES.md")).toBe(
      "An answer from another seat.",
    );
    const lock = JSON.parse(world.file("cart-total", "test-lock.json")) as SavedLock;
    expect(lock.files.map((f) => f.path)).toEqual([TEST_FILE]);
    expect(state.tasks[0]).toMatchObject({ status: "done" });
  });
});

describe("a tests first escalation", () => {
  it("gives the Test engineer more rounds after a retry, and the build goes on", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [testRound(4, RED_TEST), { ...testRound(1, GREEN_TEST), match: "round [123] of" }],
      claude: [DEVELOPER],
    });
    await world.start("cart-total");
    await world.settle("cart-total");

    await world.manager.resolve("cart-total", {
      escalation: "E1",
      action: "retry",
      note: "The stub returns 0, so a sum test fails on it.",
    });
    const state = await world.waitFor("cart-total", (s) => s.step === "review");

    expect(state.tasks[0]).toMatchObject({ status: "done" });
    expect(world.calls().map((c) => c.cli)).toEqual(["codex", "codex", "codex", "codex", "claude"]);
    expect(world.calls()[3]?.prompt).toContain("round 4 of 6");
    const lock = JSON.parse(world.file("cart-total", "test-lock.json")) as SavedLock;
    expect(lock.redCheck).toBe("tests-first/round-4.json");
  });
});

interface SavedAttempt {
  gate: {
    passed: boolean;
    permission: { passed: boolean };
    lock?: { passed: boolean; changed: string[] };
  };
}

describe("the test lock", () => {
  it("fails a Developer attempt that changes a locked test and puts it back, and lets a Developer add a test file", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    const extra = 'import assert from "node:assert/strict";\nassert.ok(true);\n';
    world.script({
      codex: [testRound(1, RED_TEST)],
      claude: [
        {
          match: "attempt 1 of",
          output: REPORT,
          writeFiles: { "src/cart.mjs": CART_DONE, [TEST_FILE]: GREEN_TEST },
        },
        {
          match: "attempt 2 of",
          output: REPORT,
          writeFiles: { "src/cart.mjs": CART_DONE, "test/extra.test.mjs": extra },
        },
      ],
    });
    const plan = cartPlan();
    const task = plan.tasks[0];
    if (task) task.ownedFiles = ["src/cart.mjs", "test/**"];

    await world.start("cart-total", plan);
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused" });
    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 2 });
    const [first, second] = world.jsonFiles("cart-total", "tasks/T1") as SavedAttempt[];
    expect(first?.gate).toMatchObject({
      passed: false,
      permission: { passed: true },
      lock: { passed: false, changed: [TEST_FILE] },
    });
    expect(second?.gate).toMatchObject({ passed: true, lock: { passed: true, changed: [] } });
    expect(world.calls()[2]?.prompt).toMatch(/locked test/i);
    expect(world.git(world.root, "show", `build/cart-total:${TEST_FILE}`)).toBe(RED_TEST.trim());
    expect(world.git(world.root, "show", "build/cart-total:test/extra.test.mjs")).toBe(
      extra.trim(),
    );
  });
});
