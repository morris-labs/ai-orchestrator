// The usage estimate table through the engine build API: each finished
// build adds its corrected usage to the table for its size, and the
// Analyst's prompt carries the table's figures.
import { describe, expect, it } from "vitest";
import type { BuildStep } from "@aio/contracts";
import { CART_DONE, PROJECT_ID, REPORT, buildWorld, cartPlan, type BuildWorld } from "./harness.js";

const STEPS: readonly BuildStep[] = ["preflight", "tasks"];

const SPEC = {
  title: "Add a total to the cart",
  summary: "Shoppers see what their cart costs.",
  stories: ["As a shopper, I want the cart's total, so that I know what I pay."],
  edgeCases: ["An empty cart totals zero."],
  criteria: [
    {
      id: "AC1",
      text: "The cart reports the sum of its item prices.",
      verification: "test",
      alreadyHolds: false,
    },
  ],
  size: "medium",
  usageEstimate: { low: 1_000_000, high: 2_000_000 },
  secrets: [],
  services: [],
};

/** Runs a one-task medium build whose Developer call reports `tokensIn` tokens in. */
async function finishBuild(world: BuildWorld, slug: string, tokensIn: number): Promise<void> {
  world.script({
    claude: [
      {
        match: "Task T1",
        output: REPORT,
        writeFiles: { "src/cart.mjs": CART_DONE },
        tokens: { input: tokensIn, output: 1_000 },
      },
    ],
  });
  await world.start(slug, cartPlan({ size: "medium" }));
  const state = await world.settle(slug);
  expect(state.status).toBe("finished");
}

/** Calls the Analyst for build `slug` and returns the prompt it got. */
async function analystPrompt(world: BuildWorld, slug: string): Promise<string> {
  world.script({ claude: [{ match: "You are the Analyst", output: SPEC }] });
  const before = world.calls().length;
  await world.manager.plan({
    projectId: PROJECT_ID,
    boxId: "box-1",
    slug,
    seat: "analyst",
    brief: "Add a total to the cart.",
  });
  const call = world
    .calls()
    .slice(before)
    .find((c) => c.prompt.includes("You are the Analyst"));
  expect(call).toBeDefined();
  return call?.prompt ?? "";
}

/** The table row of `size` in an Analyst prompt. */
function row(prompt: string, size: string): string {
  return prompt.split("\n").find((line) => line.startsWith(`| ${size} |`)) ?? "";
}

describe("the usage estimate table", () => {
  it("anchors the Analyst on the built-in measured builds before any build finishes", async () => {
    const world = await buildWorld({ steps: STEPS });

    const prompt = await analystPrompt(world, "first-plan");

    expect(row(prompt, "small")).toContain("2,000,000");
    expect(row(prompt, "medium")).toContain("54,000,000");
  });

  it("learns from finished builds: two builds change the third build's estimate", async () => {
    const world = await buildWorld({ steps: STEPS });
    await finishBuild(world, "cart-one", 30_000_000);
    await finishBuild(world, "cart-two", 50_000_000);

    const prompt = await analystPrompt(world, "cart-three");

    const medium = row(prompt, "medium");
    expect(medium).toContain("| 2 |");
    expect(medium).toContain("30,000,000");
    expect(medium).toContain("40,000,000");
    expect(medium).toContain("50,000,000");
    expect(medium).not.toContain("54,000,000");
    // Another size keeps its built-in anchor.
    expect(row(prompt, "small")).toContain("2,000,000");
  });

  it("counts the build's review run in its usage", async () => {
    const world = await buildWorld({ steps: [...STEPS, "review"], review: true });
    const reviewer = { output: { findings: [] }, tokens: { input: 1_000_000, output: 10 } };
    const developer = {
      match: "Task T1",
      output: REPORT,
      writeFiles: { "src/cart.mjs": CART_DONE },
      tokens: { input: 10_000_000, output: 1_000 },
    };
    world.script({ claude: [developer, reviewer], codex: [reviewer] });
    await world.start("cart-review", cartPlan({ size: "large" }));
    expect((await world.settle("cart-review")).status).toBe("finished");
    const reviewCalls = world.calls().filter((c) => !c.prompt.includes("Task T1")).length;
    expect(reviewCalls).toBeGreaterThan(0);

    const prompt = await analystPrompt(world, "cart-next");

    expect(row(prompt, "large")).toContain(
      (10_000_000 + reviewCalls * 1_000_000).toLocaleString("en-US"),
    );
  });

  it("keeps the table across an engine restart", async () => {
    const world = await buildWorld({ steps: STEPS });
    await finishBuild(world, "cart-one", 30_000_000);
    await world.restart();

    const prompt = await analystPrompt(world, "cart-two");

    expect(row(prompt, "medium")).toContain("| 1 |");
    expect(row(prompt, "medium")).toContain("30,000,000");
  });
});
