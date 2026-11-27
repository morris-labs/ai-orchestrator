// The Developer context pack (#106): each task call's prompt carries a pack
// with the owned files' contents, the contract files, the task's excerpt of
// the build plan, and its acceptance criteria, and tells the agent not to
// survey the repository. Retries reuse the pack. Driven through the prompts
// that reach the mock CLI.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CART_DONE,
  CART_STUB,
  CART_WRONG,
  REPORT,
  buildWorld,
  cartPlan,
  type BuildWorld,
} from "./harness.js";

const PRICES = "export const CURRENCY = 'USD';\n";

/** Writes and commits files in the project, so the build branch starts from them. */
function commitFiles(world: BuildWorld, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(world.root, path)), { recursive: true });
    writeFileSync(join(world.root, path), content);
  }
  world.git(world.root, "add", "-A");
  world.git(world.root, "commit", "-q", "-m", "chore: add files");
}

/** The context pack section of a task prompt. */
function packOf(prompt: string | undefined): string {
  const match = /## Context pack\n[\s\S]*?(?=\n## |$)/.exec(prompt ?? "");
  expect(match, "the prompt has a context pack").not.toBeNull();
  return match?.[0] ?? "";
}

/** A plan with a milestone, a contract file, and a second task the excerpt leaves out. */
function packPlan(ownedFiles: string[] = ["src/cart.mjs"]) {
  return cartPlan({
    architecture: "The cart module sums prices; the prices module holds the currency.",
    milestones: [
      { id: "M1", title: "Totals", goal: "The cart shows a total.", tasks: ["T1"] },
      { id: "M2", title: "Receipts", goal: "The shop prints a receipt.", tasks: ["T2"] },
    ],
    criteria: [
      { id: "AC1", text: "The cart reports the sum of its item prices." },
      { id: "AC2", text: "The shop prints a receipt with the total." },
    ],
    tasks: [
      {
        id: "T1",
        title: "Cart total",
        description: "Make total() return the sum of the item prices.",
        ownedFiles,
        contracts: ["src/prices.mjs"],
        criteria: ["AC1"],
        tests: ["test/cart.test.mjs"],
      },
      {
        id: "T2",
        title: "Receipt printer",
        description: "Print a receipt that shows the cart total.",
        ownedFiles: ["src/receipt.mjs"],
        criteria: ["AC2"],
        dependsOn: ["T1"],
      },
    ],
  });
}

describe("the Developer context pack", () => {
  it("carries the owned files, the contracts, the task's plan excerpt, and its criteria", async () => {
    const world = await buildWorld();
    commitFiles(world, { "src/prices.mjs": PRICES });
    world.script({
      claude: [
        { match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } },
        {
          match: "Task T2",
          output: { summary: "Added the receipt.", criteria: [{ id: "AC2", met: true }] },
          writeFiles: { "src/receipt.mjs": "export const receipt = () => 'Total';\n" },
        },
      ],
    });

    await world.start("cart-total", packPlan());
    await world.waitFor("cart-total", (s) => s.step === "review");

    const prompt = world.calls().find((c) => c.prompt.includes("Task T1"))?.prompt;
    const pack = packOf(prompt);
    expect(pack).toContain("Don't survey the repository");
    // The owned file's contents and the contract file's contents.
    expect(pack).toContain('<file path="src/cart.mjs">');
    expect(pack).toContain(CART_STUB.trim());
    expect(pack).toContain('<file path="src/prices.mjs">');
    expect(pack).toContain(PRICES.trim());
    // The task's excerpt of the build plan: its milestone and its own entry, not the other task's.
    expect(pack).toContain("The cart shows a total.");
    expect(pack).toContain("Make total() return the sum of the item prices.");
    expect(pack).toContain("The cart module sums prices");
    expect(pack).not.toContain("Print a receipt that shows the cart total.");
    expect(pack).not.toContain("The shop prints a receipt.");
    // Its acceptance criteria, and only its own.
    expect(pack).toContain("AC1: The cart reports the sum of its item prices.");
    expect(pack).not.toContain("AC2:");

    // The engine saves the pack in the build directory.
    expect(world.file("cart-total", "tasks/T1/pack.md")).toContain(CART_STUB.trim());
  });

  it("is reused by a retry of the same task", async () => {
    const world = await buildWorld();
    commitFiles(world, { "src/prices.mjs": PRICES });
    world.script({
      claude: [
        { match: "attempt 1 of", output: REPORT, writeFiles: { "src/cart.mjs": CART_WRONG } },
        { match: "attempt 2 of", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } },
      ],
    });

    await world.start("cart-total", cartPlan({ tasks: [{ ...packPlan().tasks![0]! }] }));
    const state = await world.waitFor("cart-total", (s) => s.step === "review");

    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 2 });
    const prompts = world
      .calls()
      .filter((c) => c.prompt.includes("Task T1"))
      .map((c) => c.prompt);
    expect(prompts).toHaveLength(2);
    // The second attempt gets the same pack, though the first attempt changed the owned file.
    expect(packOf(prompts[1])).toBe(packOf(prompts[0]));
    expect(packOf(prompts[1])).not.toContain(CART_WRONG.trim());
  });

  it("keeps large files out by reference and expands owned globs", async () => {
    const world = await buildWorld();
    const big = `export const ROWS = [\n${"  'row',\n".repeat(20_000)}];\n`;
    commitFiles(world, {
      "src/prices.mjs": PRICES,
      "src/data/rows.mjs": big,
      "src/data/small.mjs": "export const SMALL = 1;\n",
    });
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });

    const plan = packPlan(["src/cart.mjs", "src/data/*.mjs", "src/new.mjs"]);
    await world.start("cart-total", cartPlan({ tasks: [{ ...plan.tasks![0]! }] }));
    await world.waitFor("cart-total", (s) => s.step === "review");

    const pack = packOf(world.calls().find((c) => c.prompt.includes("Task T1"))?.prompt);
    // The glob's small file is inline; its large file is named with its size, not inlined.
    expect(pack).toContain('<file path="src/data/small.mjs">');
    expect(pack).not.toContain('<file path="src/data/rows.mjs">');
    expect(pack).toMatch(/`src\/data\/rows\.mjs`: \d+ KB, 20,002 lines/);
    expect(pack.length).toBeLessThan(big.length / 2);
    // An owned file that doesn't exist yet is listed as one the task creates.
    expect(pack).toMatch(/`src\/new\.mjs`: doesn't exist yet/);
  });
});
