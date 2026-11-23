// Builds whose plan has several tasks: they run one at a time in dependency
// order, and each task gate also runs the tests that earlier tasks made pass.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BuildPlanInput } from "@aio/contracts";
import type { TaskGateResult } from "../../src/build/index.js";
import { describe, expect, it } from "vitest";
import { CART_DONE, CART_WRONG, REPORT, buildWorld, cartPlan, type BuildWorld } from "./harness.js";

const DISCOUNT_STUB = "export function discounted(items, percent) {\n  return 0;\n}\n";
const DISCOUNT_DONE = [
  'import { total } from "./cart.mjs";',
  "export function discounted(items, percent) {",
  "  return (total(items) * (100 - percent)) / 100;",
  "}",
  "",
].join("\n");
const RECEIPT_STUB = "export function receipt(items) {\n  return \"\";\n}\n";
const RECEIPT_DONE = [
  'import { total } from "./cart.mjs";',
  "export function receipt(items) {",
  "  return `Total: ${total(items)}`;",
  "}",
  "",
].join("\n");

/** Adds the discount and receipt modules, as stubs with their tests, to the sample project. */
function addModules(world: BuildWorld): void {
  const files: Record<string, string> = {
    "src/discount.mjs": DISCOUNT_STUB,
    "test/discount.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { discounted } from "../src/discount.mjs";',
      "assert.equal(discounted([{ price: 10 }, { price: 10 }], 10), 18);",
      "",
    ].join("\n"),
    "src/receipt.mjs": RECEIPT_STUB,
    "test/receipt.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { receipt } from "../src/receipt.mjs";',
      'assert.equal(receipt([{ price: 2 }, { price: 3 }]), "Total: 5");',
      "",
    ].join("\n"),
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
    expect(gate("T3").commands.filter((c) => c.kind === "test").map((c) => c.passed)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("refuses a plan with a dependency cycle before it creates the build branch", async () => {
    const world = await buildWorld();
    const plan = threeTaskPlan();
    plan.tasks = plan.tasks.map((t) => (t.id === "T1" ? { ...t, dependsOn: ["T3"] } : t));

    await expect(world.start("checkout", plan)).rejects.toThrow(/dependency cycle: T3 -> T2 -> T1 -> T3/);
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
