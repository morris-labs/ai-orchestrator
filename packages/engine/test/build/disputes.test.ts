// Test disputes through the engine build API: a Developer that believes a
// locked test is wrong disputes it in its report. The Test engineer amends
// the test or rejects the dispute, the Project manager rules on repeated
// disputes, and the owner decides an amendment that changes a criterion.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import { BuildWorktree } from "../../src/build/worktree.js";
import { CART_DONE, REPORT, buildWorld, cartPlan, type MockResponse } from "./harness.js";

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
    expect(world.git(world.root, "show", `build/cart-total:${TEST_FILE}`)).toBe(RIGHT_TEST.trim());
    expect(world.git(world.root, "show", "build/cart-total:src/cart.mjs")).toBe(CART_DONE.trim());
  });
});

describe("a test dispute that waits for the Test engineer", () => {
  it("keeps a commit that lands on the branch before the Test engineer's turn starts", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        testsFirst(WRONG_TEST),
        { match: "test dispute", times: 2, error: "crash" },
        verdict({ verdict: "amend", reason: "The test wanted double the sum." }, RIGHT_TEST),
      ],
      claude: [disputing("attempt 1 of")],
    });

    await world.start("cart-total");
    const waiting = await world.settle("cart-total");
    expect(waiting).toMatchObject({ status: "waiting_escalation" });
    const [escalation] = waiting.escalations;
    expect(escalation).toMatchObject({ kind: "agent_call", taskId: "T1" });

    // Another seat's message turn commits while the dispute waits for the
    // Test engineer: the dispute started before this commit.
    const tree = BuildWorktree.pathFor(world.root, "cart-total");
    writeFileSync(join(tree, "NOTES.md"), "An answer from another seat.\n");
    world.git(tree, "add", "NOTES.md");
    world.git(tree, "commit", "-q", "-m", "docs: answer another seat");

    await world.manager.resolve("cart-total", { escalation: escalation!.id, action: "retry" });
    // The engine writes the lock before it settles the dispute, so wait for both.
    await world.waitFor(
      "cart-total",
      () => lockOf(world).amendments?.length === 1 && dispute(world, 1).outcome === "amended",
    );

    const amended = lockOf(world).amendments![0]!.commit;
    expect(world.git(tree, "show", "--name-only", "--format=", amended).trim()).toBe(TEST_FILE);
    expect(world.git(tree, "show", `${amended}:${TEST_FILE}`)).toBe(RIGHT_TEST.trim());
    expect(world.git(tree, "show", `${amended}:NOTES.md`)).toBe("An answer from another seat.");
  });

  it("still puts back a file outside the test that the Test engineer changed", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        testsFirst(WRONG_TEST),
        {
          ...verdict({ verdict: "amend", reason: "The test wanted double the sum." }, RIGHT_TEST),
          writeFiles: { [TEST_FILE]: RIGHT_TEST, "NOTES.md": "The Test engineer's note.\n" },
        },
      ],
      claude: [finishing("test dispute 1 .*amended"), disputing("attempt 1 of")],
    });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state.tasks[0]).toMatchObject({ status: "done" });
    expect(dispute(world, 1)).toMatchObject({ outcome: "amended" });
    expect(world.git(world.root, "ls-tree", "--name-only", "build/cart-total", "NOTES.md")).toBe(
      "",
    );
  });
});

describe("a test dispute that the Test engineer settles", () => {
  it("ends rejected with the Test engineer's reason, the test stands, and the attempt doesn't count", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        testsFirst(RIGHT_TEST),
        verdict({ verdict: "reject", reason: "AC1 wants the sum, and the test checks the sum." }),
      ],
      claude: [finishing("test dispute 1 .*rejected"), disputing("attempt 1 of")],
    });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused" });
    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(dispute(world, 1)).toMatchObject({
      outcome: "rejected",
      note: expect.stringContaining("AC1 wants the sum, and the test checks the sum."),
    });
    expect(world.calls()[3]?.prompt).toContain("AC1 wants the sum, and the test checks the sum.");
    const lock = lockOf(world);
    expect(lock.files).toEqual([{ path: TEST_FILE, sha256: sha256(RIGHT_TEST) }]);
    expect(lock.amendments).toBeUndefined();
  });

  it("doesn't lock a fix that fails the red check, and the test stands", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        testsFirst(WRONG_TEST),
        verdict({ verdict: "amend", reason: "Checks an empty cart instead." }, GREEN_TEST),
      ],
      claude: [
        { ...finishing("test dispute 1 .*rejected"), writeFiles: { "src/cart.mjs": CART_DONE } },
        disputing("attempt 1 of"),
      ],
    });

    await world.start("cart-total");
    await world.settle("cart-total");

    expect(dispute(world, 1)).toMatchObject({
      outcome: "rejected",
      check: { passed: false, tests: [{ outcome: "passed" }] },
      note: expect.stringMatching(/failed the red check.*passes before the code exists/),
    });
    const lock = lockOf(world);
    expect(lock.files).toEqual([{ path: TEST_FILE, sha256: sha256(WRONG_TEST) }]);
    expect(lock.amendments).toBeUndefined();
    expect(world.git(world.root, "show", `build/cart-total:${TEST_FILE}`)).toBe(WRONG_TEST.trim());
  });
});

describe("a test dispute that the Project manager rules on", () => {
  it("takes a second dispute about one test, and the ruling reaches the Developer", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        testsFirst(RIGHT_TEST),
        { ...verdict({ verdict: "reject", reason: "The ruling keeps it." }), match: "ruled on" },
        verdict({ verdict: "reject", reason: "The test is right." }),
      ],
      claude: [finishing("Project manager decided"), disputing("attempt 1 of")],
    });

    await world.start("cart-total");
    const waiting = await world.settle("cart-total");

    expect(waiting).toMatchObject({ step: "tasks", status: "waiting_escalation" });
    expect(waiting.tasks[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(waiting.escalations).toEqual([
      expect.objectContaining({ id: "E1", kind: "test_dispute", level: "project_manager" }),
    ]);
    expect(dispute(world, 1)).toMatchObject({ outcome: "rejected" });
    expect(dispute(world, 2)).toMatchObject({ outcome: "ruled", escalation: "E1" });
    expect(world.file("cart-total", "escalations/E1.json")).toContain("dispute-1.json");
    expect(world.calls().map((c) => c.cli)).toEqual(["codex", "claude", "codex", "claude"]);

    await world.manager.resolve("cart-total", {
      escalation: "E1",
      action: "clarify",
      note: "The test is right: AC1 is the plain sum.",
    });
    const state = await world.waitFor("cart-total", (s) => s.step === "review");

    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(world.calls().map((c) => c.cli)).toEqual([
      "codex",
      "claude",
      "codex",
      "claude",
      "codex",
      "claude",
    ]);
    expect(world.calls()[4]?.prompt).toContain("The test is right: AC1 is the plain sum.");
    expect(dispute(world, 2)).toMatchObject({ outcome: "rejected", escalation: "E1" });
    expect(world.calls()[5]?.prompt).toContain("The test is right: AC1 is the plain sum.");
    expect(lockOf(world).files).toEqual([{ path: TEST_FILE, sha256: sha256(RIGHT_TEST) }]);
  });

  it("has the Test engineer apply a ruling against a locked test, then locks the fixed test", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        testsFirst(WRONG_TEST),
        {
          ...verdict({ verdict: "amend", reason: "Applied the ruling." }, RIGHT_TEST),
          match: "ruled on",
        },
        verdict({ verdict: "reject", reason: "The test is right." }),
      ],
      claude: [
        finishing("The fixed test is locked"),
        disputing("is rejected"),
        disputing("attempt 1 of"),
      ],
    });

    await world.start("cart-total");
    await world.settle("cart-total");
    expect(dispute(world, 2)).toMatchObject({ outcome: "ruled", escalation: "E1" });
    expect(lockOf(world).files).toEqual([{ path: TEST_FILE, sha256: sha256(WRONG_TEST) }]);

    await world.manager.resolve("cart-total", {
      escalation: "E1",
      action: "clarify",
      note: "The test is wrong: AC1 is the plain sum, 5, not 10.",
    });
    const state = await world.waitFor("cart-total", (s) => s.step === "review");

    expect(state.tasks[0]).toMatchObject({ status: "done" });
    const ruled = world.calls()[4];
    expect(ruled?.cli).toBe("codex");
    expect(ruled?.prompt).toContain("The test is wrong: AC1 is the plain sum, 5, not 10.");
    expect(dispute(world, 2)).toMatchObject({
      outcome: "amended",
      escalation: "E1",
      ruling: "The test is wrong: AC1 is the plain sum, 5, not 10.",
      check: { passed: true },
    });
    const lock = lockOf(world);
    expect(lock.files).toEqual([{ path: TEST_FILE, sha256: sha256(RIGHT_TEST) }]);
    expect(lock.amendments).toEqual([
      expect.objectContaining({
        taskId: "T1",
        test: TEST_FILE,
        dispute: "tasks/T1/dispute-2.json",
      }),
    ]);
    expect(world.git(world.root, "show", `build/cart-total:${TEST_FILE}`)).toBe(RIGHT_TEST.trim());
  });

  it("takes a third dispute in one task", async () => {
    const files = ["test/a.test.mjs", "test/b.test.mjs", "test/c.test.mjs"];
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    const claims = files.map((file, i) => ({
      match: i === 0 ? "attempt 1 of" : `test dispute ${i} about ${files[i - 1]} is rejected`,
      output: { ...REPORT, dispute: { test: file, reason: `Doubts ${file}.` } },
      writeFiles: { "src/cart.mjs": CART_DONE },
    }));
    world.script({
      codex: [
        {
          match: "round 1 of",
          output: {
            summary: "Wrote the tests first.",
            tests: files.map((file) => ({ ...AC1_TEST, file, command: `node ${file}` })),
          },
          writeFiles: Object.fromEntries(files.map((file) => [file, RIGHT_TEST])),
        },
        { ...verdict({ verdict: "reject", reason: "The test is right." }), times: 2 },
      ],
      claude: [...claims].reverse(),
    });
    const plan = cartPlan();
    const task = plan.tasks[0];
    if (task) task.tests = files;

    await world.start("cart-total", plan);
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "tasks", status: "waiting_escalation" });
    expect(state.tasks[0]).toMatchObject({ attempts: 1 });
    expect(state.escalations).toEqual([
      expect.objectContaining({ kind: "test_dispute", level: "project_manager" }),
    ]);
    expect(dispute(world, 3)).toMatchObject({ test: "test/c.test.mjs", outcome: "ruled" });
    expect(world.calls().filter((c) => c.cli === "codex")).toHaveLength(3);
  });
});

describe("a test dispute that the owner decides", () => {
  it("escalates an amendment that changes a criterion, then locks it when the owner changes the criteria", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        testsFirst(WRONG_TEST),
        verdict(
          { verdict: "amend", reason: "AC1 should mean the sum.", changesCriterion: true },
          RIGHT_TEST,
        ),
      ],
      claude: [finishing("test dispute 1 .*amended"), disputing("attempt 1 of")],
    });

    await world.start("cart-total");
    const waiting = await world.settle("cart-total");

    expect(waiting).toMatchObject({ step: "tasks", status: "waiting_escalation" });
    expect(waiting.escalations).toEqual([
      expect.objectContaining({ id: "E1", kind: "test_dispute", level: "owner" }),
    ]);
    expect(dispute(world, 1)).toMatchObject({ outcome: "escalated", escalation: "E1" });
    expect(lockOf(world).files).toEqual([{ path: TEST_FILE, sha256: sha256(WRONG_TEST) }]);
    expect(world.file("cart-total", "tasks/T1/dispute-1.patch")).toContain(
      "total([{ price: 2 }, { price: 3 }]), 5)",
    );

    await world.manager.resolve("cart-total", {
      escalation: "E1",
      action: "retry",
      by: "owner",
      changes: ["criteria"],
      note: "AC1 means the plain sum.",
    });
    const state = await world.waitFor("cart-total", (s) => s.step === "review");

    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(dispute(world, 1)).toMatchObject({ outcome: "amended", check: { passed: true } });
    const lock = lockOf(world);
    expect(lock.files).toEqual([{ path: TEST_FILE, sha256: sha256(RIGHT_TEST) }]);
    expect(lock.amendments).toEqual([
      expect.objectContaining({ reason: "AC1 should mean the sum." }),
    ]);
    expect(world.git(world.root, "show", `build/cart-total:${TEST_FILE}`)).toBe(RIGHT_TEST.trim());
  });

  it("keeps the test as it is locked when the owner retries without changing the criteria", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    world.script({
      codex: [
        testsFirst(RIGHT_TEST),
        verdict(
          { verdict: "amend", reason: "AC1 could mean the count.", changesCriterion: true },
          WRONG_TEST,
        ),
      ],
      claude: [finishing("owner decided"), disputing("attempt 1 of")],
    });

    await world.start("cart-total");
    await world.settle("cart-total");
    await world.manager.resolve("cart-total", {
      escalation: "E1",
      action: "retry",
      by: "owner",
      note: "AC1 is the sum; keep the test.",
    });
    const state = await world.waitFor("cart-total", (s) => s.step === "review");

    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(dispute(world, 1)).toMatchObject({ outcome: "escalated" });
    expect(lockOf(world).files).toEqual([{ path: TEST_FILE, sha256: sha256(RIGHT_TEST) }]);
    expect(world.calls().at(-1)?.prompt).toContain("AC1 is the sum; keep the test.");
  });
});

const LABEL_FILE = "test/label.test.mjs";
const LABEL_TEST = [
  "// AC2: an item label names the item.",
  'import assert from "node:assert/strict";',
  'import { label } from "../src/label.mjs";',
  'assert.equal(label("pen"), "Item: pen");',
  "",
].join("\n");

describe("a test dispute in a task that waits", () => {
  it("keeps the amended test on the branch while the task's work is set aside", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    writeFileSync(
      join(world.root, "src", "label.mjs"),
      'export function label() {\n  return "";\n}\n',
    );
    world.git(world.root, "add", "-A");
    world.git(world.root, "commit", "-q", "-m", "feat: add a label stub");
    const plan = cartPlan({
      criteria: [
        { id: "AC1", text: "The cart reports the sum of its item prices." },
        { id: "AC2", text: "An item label names the item." },
      ],
      tasks: [
        { ...cartPlan().tasks[0]!, id: "T1" },
        {
          id: "T2",
          title: "Label",
          description: "Make label() name the item.",
          ownedFiles: ["src/label.mjs"],
          criteria: ["AC2"],
          tests: [LABEL_FILE],
        },
      ],
      commands: {
        test: [{ command: RUN_TEST }, { command: `node ${LABEL_FILE}` }],
        typecheck: [{ command: "node --check src/cart.mjs" }],
        lint: [{ command: "node lint.mjs" }],
      },
    });
    const blocked = {
      kind: "service",
      name: "price-service",
      reason: "The price service is down.",
    };
    world.script({
      codex: [
        {
          match: "round 1 of",
          output: {
            summary: "Wrote the tests first.",
            tests: [
              AC1_TEST,
              {
                file: LABEL_FILE,
                name: "AC2: an item label names the item",
                criterion: "AC2",
                command: `node ${LABEL_FILE}`,
              },
            ],
          },
          writeFiles: { [TEST_FILE]: WRONG_TEST, [LABEL_FILE]: LABEL_TEST },
        },
        verdict({ verdict: "amend", reason: "The test wanted double the sum." }, RIGHT_TEST),
      ],
      claude: [
        // After the dispute, T1 reports a missing service and waits for the owner.
        {
          match: "test dispute 1 .*amended",
          output: { ...REPORT, blocked },
          writeFiles: { "src/cart.mjs": CART_DONE },
        },
        disputing("Task T1"),
        {
          match: "Task T2",
          output: { summary: "Added the label.", criteria: [{ id: "AC2", met: true }] },
          writeFiles: {
            "src/label.mjs": "export function label(name) {\n  return `Item: ${name}`;\n}\n",
          },
        },
      ],
    });

    await world.start("cart-total", plan);
    const state = await world.settle("cart-total");

    expect(state.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T1", "failed", 1],
      ["T2", "done", 1],
    ]);
    expect(world.git(world.root, "show", `build/cart-total:${TEST_FILE}`)).toBe(RIGHT_TEST.trim());
    expect(world.git(world.root, "show", "build/cart-total:src/cart.mjs")).not.toBe(
      CART_DONE.trim(),
    );
    const patch = world.file("cart-total", "tasks/T1/set-aside-1.patch");
    expect(patch).toContain("src/cart.mjs");
    expect(patch).not.toContain(TEST_FILE);
  });
});
