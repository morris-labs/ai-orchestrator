// The task limit by build size: the plan check refuses a medium plan with
// more than five tasks and a small plan with more than one, and the planning
// seats hear the limit in their prompts.
import { describe, expect, it } from "vitest";
import type { BuildPlanInput } from "@aio/contracts";
import { PROJECT_ID, buildWorld, cartPlan } from "./harness.js";

const SLUG = "cart-total";

/** A plan of `count` tasks, each owning its own file and test. */
function planWith(
  size: "small" | "medium" | "large",
  count: number,
  contracts: string[] = [],
): BuildPlanInput {
  const ids = Array.from({ length: count }, (_, i) => `T${i + 1}`);
  return cartPlan({
    size,
    tasks: ids.map((id, i) => ({
      id,
      title: `Part ${i + 1}`,
      description: `Build part ${i + 1} of the cart.`,
      ownedFiles: [`src/part${i + 1}.mjs`],
      contracts,
      criteria: ["AC1"],
      tests: [`test/part${i + 1}.test.mjs`],
    })),
  });
}

function freeze(plan: BuildPlanInput) {
  return {
    projectId: PROJECT_ID,
    boxId: "box-1",
    slug: SLUG,
    plan,
    push: true,
    flow: "pipeline" as const,
  };
}

describe("the task limit by build size", () => {
  it("refuses to freeze a medium plan with six tasks, naming the limit", async () => {
    const world = await buildWorld();
    await expect(world.manager.freeze(freeze(planWith("medium", 6)))).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/medium build has at most 5 tasks/),
    });
  });

  it("refuses to freeze a small plan with two tasks, naming the limit", async () => {
    const world = await buildWorld();
    await expect(world.manager.freeze(freeze(planWith("small", 2)))).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/small build has at most 1 task\b/),
    });
  });

  it("refuses to start a medium build from a plan with six tasks", async () => {
    const world = await buildWorld();
    await expect(world.start(SLUG, planWith("medium", 6))).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/at most 5 tasks/),
    });
  });

  it("freezes a medium plan with five tasks and a Contracts step", async () => {
    const world = await buildWorld();
    const plan = planWith("medium", 5, ["src/types.mjs"]);
    const answer = await world.manager.freeze(freeze(plan));
    expect(answer.plan.tasks).toHaveLength(5);
    expect(answer.plan.tasks.every((t) => t.contracts.includes("src/types.mjs"))).toBe(true);
  });

  it("sets no task limit on a large build", async () => {
    const world = await buildWorld();
    const answer = await world.manager.freeze(freeze(planWith("large", 8)));
    expect(answer.plan.tasks).toHaveLength(8);
  });

  it("states the limit in the Analyst's and the Architect's prompts", async () => {
    const world = await buildWorld();
    world.script({
      claude: [
        { match: "You are the Analyst", output: { title: "x" } },
        { match: "You are the Architect", output: { architecture: "x" } },
      ],
    });
    const seat = (name: string) => ({
      projectId: PROJECT_ID,
      boxId: "box-1",
      slug: SLUG,
      seat: name,
      brief: "Add a total to the cart.",
    });
    // The answers break the schemas; only the prompts matter here.
    await world.manager.plan(seat("analyst")).catch(() => undefined);
    await world.manager.plan(seat("architect")).catch(() => undefined);

    for (const role of ["Analyst", "Architect"]) {
      const prompt = world.calls().find((c) => c.prompt.includes(`You are the ${role}`))?.prompt;
      expect(prompt, role).toMatch(/small build has at most 1 task\b/);
      expect(prompt, role).toMatch(/medium build has at most 5 tasks/);
      expect(prompt, role).toMatch(/Contracts step doesn't count as a task/);
    }
  });
});
