// Escalations (#74): an escalation pauses only the task it names and the
// tasks that depend on it, independent tasks go on, and a resolve request
// resumes what it paused and records how it was resolved.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BuildPlanInput, Escalation } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import {
  CART_DONE,
  CART_WRONG,
  REPORT,
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
const LABEL_STUB = 'export function label(name) {\n  return "";\n}\n';
const LABEL_DONE = "export function label(name) {\n  return `Item: ${name}`;\n}\n";

const DIAGNOSIS = {
  summary: "total() counts the items instead of adding their prices.",
  cause: "src/cart.mjs returns items.length.",
  fix: "Sum item.price over the items.",
  evidence: ["test/cart.test.mjs expects 5 and gets 2."],
};

/** Adds a discount module, which needs the cart total, and a label module, which needs nothing. */
function addModules(world: BuildWorld): void {
  const files: Record<string, string> = {
    "src/discount.mjs": DISCOUNT_STUB,
    "src/label.mjs": LABEL_STUB,
    "test/discount.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { discounted } from "../src/discount.mjs";',
      "assert.equal(discounted([{ price: 10 }, { price: 10 }], 10), 18);",
      "",
    ].join("\n"),
    "test/label.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { label } from "../src/label.mjs";',
      'assert.equal(label("pen"), "Item: pen");',
      "",
    ].join("\n"),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(world.root, path)), { recursive: true });
    writeFileSync(join(world.root, path), content);
  }
  world.git(world.root, "add", "-A");
  world.git(world.root, "commit", "-q", "-m", "feat: add discount and label stubs");
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

/** T2 needs T1; T3 needs nothing. */
function threeTaskPlan(): BuildPlanInput {
  return cartPlan({
    title: "Cart total, discount, and label",
    criteria: ["T1", "T2", "T3"].map((id) => ({ id: `AC-${id}`, text: `Task ${id} works.` })),
    tasks: [
      task("T1", "Cart total", "cart"),
      task("T2", "Discount", "discount", ["T1"]),
      task("T3", "Label", "label"),
    ],
    commands: {
      test: ["cart", "discount", "label"].map((m) => ({ command: `node test/${m}.test.mjs` })),
      typecheck: [{ command: "node --check src/cart.mjs" }],
      lint: [{ command: "node lint.mjs" }],
    },
  });
}

const answer = (id: string, files: Record<string, string>, match = `Task ${id}`): MockResponse => ({
  match,
  output: { summary: `Did ${id}.`, criteria: [{ id: `AC-${id}`, met: true }] },
  writeFiles: files,
});

const taskOf = (prompt: string) =>
  prompt.startsWith("You are the Debugger") ? "D" : (/Task (T\d):/.exec(prompt)?.[1] ?? "?");

function escalationFile(world: BuildWorld, slug: string, id: string): Record<string, unknown> {
  return JSON.parse(world.file(slug, `escalations/${id}.json`)) as Record<string, unknown>;
}

describe("an escalation that pauses only what it affects", () => {
  it("lets an independent task finish while a task waits, then resumes the task and its dependents on a retry", async () => {
    const world = await buildWorld();
    addModules(world);
    world.script({
      claude: [
        { match: "You are the Debugger", output: DIAGNOSIS },
        answer("T1", { "src/cart.mjs": CART_DONE }, "attempt 5 of"),
        answer("T1", { "src/cart.mjs": CART_WRONG }),
        answer("T2", { "src/discount.mjs": DISCOUNT_DONE }),
        answer("T3", { "src/label.mjs": LABEL_DONE }),
      ],
    });

    await world.start("checkout", threeTaskPlan());
    const waiting = await world.settle("checkout");

    // T1 reached its attempt cap; T2 waits with it; T3 finished meanwhile.
    expect(waiting.status).toBe("waiting_escalation");
    expect(waiting.tasks.map((t) => [t.id, t.status])).toEqual([
      ["T1", "failed"],
      ["T2", "blocked"],
      ["T3", "done"],
    ]);
    expect(waiting.escalations).toEqual([
      expect.objectContaining({
        id: "E1",
        kind: "attempt_cap",
        level: "project_manager",
        taskId: "T1",
        tasks: ["T1", "T2"],
        status: "open",
      }),
    ]);
    expect(world.calls().map((c) => taskOf(c.prompt))).not.toContain("T2");
    expect(world.file("checkout", "STATUS.md")).toMatch(/E1 \(attempt_cap.*open.*pauses T1, T2/);

    const resumed = await world.manager.resolve("checkout", {
      escalation: "E1",
      action: "retry",
      note: "Retry after the stale fixture was fixed.",
    });
    expect(resumed.status).toBe("running");
    const state = await world.waitFor("checkout", (s) => s.step === "review");

    expect(state.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T1", "done", 5],
      ["T2", "done", 1],
      ["T3", "done", 1],
    ]);
    const calls = world.calls().map((c) => taskOf(c.prompt));
    expect(calls.slice(-2)).toEqual(["T1", "T2"]);
    // The resolution is recorded in the state and the escalation file.
    const resolved: Escalation | undefined = state.escalations[0];
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: {
        action: "retry",
        by: "project_manager",
        note: "Retry after the stale fixture was fixed.",
        resolvedAt: expect.any(String),
      },
    });
    expect(escalationFile(world, "checkout", "E1")).toMatchObject({
      status: "resolved",
      resolution: { action: "retry" },
    });
  });
});

