// Builds whose plan has several tasks: they run one at a time in dependency
// order, and each task gate also runs the tests that earlier tasks made pass.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BuildPlanInput } from "@aio/contracts";
import type { TaskGateResult } from "../../src/build/index.js";
import { describe, expect, it } from "vitest";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import {
  CART_DONE,
  CART_WRONG,
  buildWorld,
  cartPlan,
  type BuildWorld,
  type MockResponse,
} from "./harness.js";

const DISCOUNT_STUB = "export function discounted(items, percent) {\n  return 0;\n}\n";
const DISCOUNT_DONE = [
  'import { total } from "./cart.mjs";',
  "export function discounted(items, percent) {",
  "  return (total(items) * (100 - percent)) / 100;",
  "}",
  "",
].join("\n");
const RECEIPT_STUB = 'export function receipt(items) {\n  return "";\n}\n';
const RECEIPT_DONE = [
  'import { total } from "./cart.mjs";',
  "export function receipt(items) {",
  "  return `Total: ${total(items)}`;",
  "}",
  "",
].join("\n");

/** The tests of the discount and receipt modules, red against their stubs. */
const MODULE_TESTS: Record<string, string> = {
  "test/discount.test.mjs": [
    "// AC-T2: the discount applies to the cart total.",
    'import assert from "node:assert/strict";',
    'import { discounted } from "../src/discount.mjs";',
    "assert.equal(discounted([{ price: 10 }, { price: 10 }], 10), 18);",
    "",
  ].join("\n"),
  "test/receipt.test.mjs": [
    "// AC-T3: the receipt shows the cart total.",
    'import assert from "node:assert/strict";',
    'import { receipt } from "../src/receipt.mjs";',
    'assert.equal(receipt([{ price: 2 }, { price: 3 }]), "Total: 5");',
    "",
  ].join("\n"),
};

/**
 * Adds the discount and receipt modules to the sample project as stubs, with
 * their tests unless tests first writes them.
 */
function addModules(world: BuildWorld, { tests = true } = {}): void {
  const files: Record<string, string> = {
    "src/discount.mjs": DISCOUNT_STUB,
    "src/receipt.mjs": RECEIPT_STUB,
    ...(tests ? MODULE_TESTS : {}),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(world.root, path)), { recursive: true });
    writeFileSync(join(world.root, path), content);
  }
  world.git(world.root, "add", "-A");
  world.git(world.root, "commit", "-q", "-m", "feat: add discount and receipt stubs");
}

const task = (id: string, title: string, module: string, dependsOn: string[] = []) => ({
  id,
  title,
  description: `Implement ${module}.`,
  ownedFiles: [`src/${module}.mjs`],
  criteria: [`AC-${id}`],
  tests: [`test/${module}.test.mjs`],
  dependsOn,
});

/** A three-task plan, listed out of order: the receipt and discount need the cart total. */
function threeTaskPlan(): BuildPlanInput {
  return cartPlan({
    title: "Cart total, discount, and receipt",
    size: "medium",
    criteria: ["T1", "T2", "T3"].map((id) => ({ id: `AC-${id}`, text: `Task ${id} works.` })),
    tasks: [
      task("T3", "Receipt", "receipt", ["T2"]),
      task("T1", "Cart total", "cart"),
      task("T2", "Discount", "discount", ["T1"]),
    ],
    commands: {
      test: ["cart", "discount", "receipt"].map((m) => ({ command: `node test/${m}.test.mjs` })),
      typecheck: [{ command: "node --check src/cart.mjs" }],
      lint: [{ command: "node lint.mjs" }],
    },
  });
}

const answer = (id: string, files: Record<string, string>) => ({
  match: `Task ${id}`,
  times: 1,
  output: { summary: `Did ${id}.`, criteria: [{ id: `AC-${id}`, met: true }] },
  writeFiles: files,
});

/** The Test engineer's answer: every task's test, red against the stubs, each with its own command. */
const TEST_ENGINEER: MockResponse = {
  match: "round 1 of",
  output: {
    summary: "Wrote the tests first.",
    tests: ["cart", "discount", "receipt"].map((module, i) => ({
      file: `test/${module}.test.mjs`,
      name: `AC-T${i + 1}: the ${module} works`,
      criterion: `AC-T${i + 1}`,
      command: `node test/${module}.test.mjs`,
    })),
  },
  writeFiles: {
    ...MODULE_TESTS,
    "test/cart.test.mjs": [
      "// AC-T1: the cart reports the sum of its item prices.",
      'import assert from "node:assert/strict";',
      'import { total } from "../src/cart.mjs";',
      "assert.equal(total([{ price: 2 }, { price: 3 }]), 5);",
      "",
    ].join("\n"),
  },
};

/** A three-task plan whose one test command runs the whole suite. */
/** The coverage check of a medium build's tests first, which finds no gaps. */
const COVERAGE: MockResponse = {
  match: "Coverage check",
  output: {
    summary: "Read each criterion.",
    criteria: ["T1", "T2", "T3"].map((id) => ({
      id: `AC-${id}`,
      checked: true,
      reason: "A test asserts it.",
    })),
  },
};

function suitePlan(): BuildPlanInput {
  const plan = threeTaskPlan();
  return { ...plan, commands: { ...plan.commands, test: [{ command: "node --test" }] } };
}

const taskOf = (prompt: string) => /Task (T\d):/.exec(prompt)?.[1];

describe("a multi-task build", () => {
  it("runs the tasks one at a time, each after the tasks it depends on", async () => {
    const world = await buildWorld();
    addModules(world);
    world.script({
      claude: [
        answer("T1", { "src/cart.mjs": CART_DONE }),
        answer("T2", { "src/discount.mjs": DISCOUNT_DONE }),
        answer("T3", { "src/receipt.mjs": RECEIPT_DONE }),
      ],
    });

    await world.start("checkout", threeTaskPlan());
    const state = await world.settle("checkout");

    expect(world.calls().map((c) => taskOf(c.prompt))).toEqual(["T1", "T2", "T3"]);
    // Each Developer prompt lists the tasks it builds on, and names the team chat tool.
    const prompts = world.calls().map((c) => c.prompt);
    expect(prompts[0]).not.toContain("## Depends on");
    expect(prompts[1]).toContain("## Depends on\n\n- T1: Cart total");
    expect(prompts[2]).toContain("## Depends on\n\n- T2: Discount");
    for (const prompt of prompts) expect(prompt).toMatch(/## Team chat\n\n.*send_message/);
    expect(state.step).toBe("review");
    expect(state.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T3", "done", 1],
      ["T1", "done", 1],
      ["T2", "done", 1],
    ]);
    const commits = world.git(world.root, "log", "--format=%s", "main..build/checkout");
    expect(commits.split("\n").reverse()).toEqual([
      "chore(build): finish task T1, Cart total",
      "chore(build): finish task T2, Discount",
      "chore(build): finish task T3, Receipt",
    ]);
    // The first task's gate waits with the later tasks' tests; the last one runs every test.
    const gate = (id: string) =>
      (world.jsonFiles("checkout", `tasks/${id}`)[0] as { gate: TaskGateResult }).gate;
    expect(gate("T1").deferred).toEqual([
      "node test/discount.test.mjs",
      "node test/receipt.test.mjs",
    ]);
    expect(gate("T3").deferred).toBeUndefined();
    expect(
      gate("T3")
        .commands.filter((c) => c.kind === "test")
        .map((c) => c.passed),
    ).toEqual([true, true, true]);
  });

  it("checks each task with one test suite command while later tasks' tests are still red", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    addModules(world, { tests: false });
    world.script({
      codex: [TEST_ENGINEER],
      claude: [
        COVERAGE,
        answer("T1", { "src/cart.mjs": CART_DONE }),
        answer("T2", { "src/discount.mjs": DISCOUNT_DONE }),
        answer("T3", { "src/receipt.mjs": RECEIPT_DONE }),
      ],
    });
    await world.start("suite", suitePlan());
    const state = await world.settle("suite");

    expect(state.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T3", "done", 1],
      ["T1", "done", 1],
      ["T2", "done", 1],
    ]);
    // The gate set the later tasks' tests aside while the suite ran, and put them back.
    const tip = world.git(world.root, "ls-tree", "--name-only", "-r", "build/suite", "test");
    expect(tip.split("\n")).toEqual([
      "test/cart.test.mjs",
      "test/discount.test.mjs",
      "test/receipt.test.mjs",
    ]);
    const gate = (world.jsonFiles("suite", "tasks/T1")[0] as { gate: TaskGateResult }).gate;
    expect(gate.setAside).toEqual(["test/discount.test.mjs", "test/receipt.test.mjs"]);
  });

  it("still fails a task on its own test while the later tasks' tests are set aside", async () => {
    const world = await buildWorld({ steps: BUILD_PIPELINE });
    addModules(world, { tests: false });
    world.script({
      codex: [TEST_ENGINEER],
      claude: [COVERAGE, { ...answer("T1", { "src/cart.mjs": CART_WRONG }), times: 4 }],
    });

    await world.start("suite", suitePlan());
    const state = await world.settle("suite");

    expect(state.tasks.find((t) => t.id === "T1")).toMatchObject({ status: "failed" });
    expect(state.status).toBe("waiting_escalation");
    const first = (world.jsonFiles("suite", "tasks/T1")[0] as { gate: TaskGateResult }).gate;
    expect(first).toMatchObject({ passed: false, setAside: expect.any(Array) });
    expect(world.git(world.root, "status", "--porcelain")).toBe("");
    expect(world.git(state.worktree, "status", "--porcelain")).not.toMatch(/test\//);
  });

  it("refuses a plan with a dependency cycle before it creates the build branch", async () => {
    const world = await buildWorld();
    const plan = threeTaskPlan();
    plan.tasks = plan.tasks.map((t) => (t.id === "T1" ? { ...t, dependsOn: ["T3"] } : t));

    await expect(world.start("checkout", plan)).rejects.toThrow(
      /dependency cycle: T3 -> T2 -> T1 -> T3/,
    );
    expect(world.git(world.root, "branch", "--list", "build/*")).toBe("");
    expect(world.calls()).toEqual([]);
  });

  it("shows each task's state and dependencies in the status file", async () => {
    const world = await buildWorld();
    addModules(world);
    world.script({
      claude: [
        answer("T1", { "src/cart.mjs": CART_DONE }),
        answer("T2", { "src/discount.mjs": DISCOUNT_STUB.replace("0", "-1") }),
      ],
    });

    await world.start("checkout", threeTaskPlan());
    await world.waitFor("checkout", (s) => s.tasks.some((t) => t.id === "T2" && t.attempts >= 2));
    const status = world.file("checkout", "STATUS.md");

    expect(status).toMatch(/\| T3 \| Receipt \| T2 \| pending \| 0 \|/);
    expect(status).toMatch(/\| T1 \| Cart total \| {2}\| done \| 1 \| `[0-9a-f]{12}` \|/);
    expect(status).toMatch(/\| T2 \| Discount \| T1 \| running \| \d \| {2}\| test command/);
  });
});

describe("a later task that breaks an earlier task's test", () => {
  /** T1 makes the cart test pass; T2 may change the cart module too. */
  function twoTaskPlan(): BuildPlanInput {
    const plan = threeTaskPlan();
    return {
      ...plan,
      criteria: plan.criteria.slice(0, 2),
      tasks: [
        task("T1", "Cart total", "cart"),
        {
          ...task("T2", "Discount", "discount", ["T1"]),
          ownedFiles: ["src/discount.mjs", "src/cart.mjs"],
        },
      ],
      commands: { ...plan.commands, test: plan.commands.test.slice(0, 2) },
    };
  }

  it("fails the gate with the broken test in the next attempt's prompt", async () => {
    const world = await buildWorld();
    addModules(world);
    world.script({
      claude: [
        answer("T1", { "src/cart.mjs": CART_DONE }),
        {
          ...answer("T2", { "src/discount.mjs": DISCOUNT_DONE, "src/cart.mjs": CART_WRONG }),
          match: "attempt 1 of",
        },
        { ...answer("T2", { "src/cart.mjs": CART_DONE }), match: "attempt 2 of" },
      ],
    });

    await world.start("discount", twoTaskPlan());
    const state = await world.settle("discount");

    expect(state.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T1", "done", 1],
      ["T2", "done", 2],
    ]);
    const [first] = world.jsonFiles("discount", "tasks/T2") as { gate: TaskGateResult }[];
    expect(first?.gate).toMatchObject({
      passed: false,
      regressions: [
        { taskId: "T1", test: "test/cart.test.mjs", command: "node test/cart.test.mjs" },
      ],
    });
    const retry = world.calls().find((c) => c.prompt.includes("attempt 2 of"));
    expect(retry?.prompt).toMatch(/Regression[^]*test\/cart\.test\.mjs \(task T1\)/);
    expect(state.escalations).toEqual([]);
  });

  it("raises an oscillation escalation when the task breaks the test again", async () => {
    const world = await buildWorld();
    addModules(world);
    world.script({
      claude: [
        answer("T1", { "src/cart.mjs": CART_DONE }),
        {
          ...answer("T2", { "src/discount.mjs": DISCOUNT_DONE, "src/cart.mjs": CART_WRONG }),
          times: 4,
        },
      ],
    });

    await world.start("discount", twoTaskPlan());
    const state = await world.settle("discount");

    expect(state.status).toBe("waiting_escalation");
    expect(state.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T1", "done", 1],
      ["T2", "failed", 2],
    ]);
    expect(state.escalations).toEqual([
      expect.objectContaining({
        id: "E1",
        kind: "oscillation",
        level: "project_manager",
        taskId: "T2",
        summary: expect.stringMatching(/T2 broke test\/cart\.test\.mjs.*T1.*again/),
      }),
    ]);
    expect(world.file("discount", "escalations/E1.json")).toContain("attempt-1.json");
    expect(world.file("discount", "STATUS.md")).toMatch(/E1 \(oscillation/);
  });
});
