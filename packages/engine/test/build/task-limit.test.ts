// The task limit by build size: the plan check refuses a medium plan with
// more than five tasks and a small plan with more than one, and the planning
// seats hear the limit in their prompts.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BuildPlanSchema, type BuildPlanInput } from "@aio/contracts";
import { planHash } from "../../src/build/planning/planner.js";
import { PROJECT_ID, buildWorld, cartPlan, type BuildWorld } from "./harness.js";

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

/** A parsed JSON object whose fields the fixtures rewrite. */
type Json = Record<string, unknown> & { frozen: Record<string, unknown>[] };

describe("the task limit after an upgrade from 3.3", () => {
  /** Changes a JSON file in the build's directory, even a read-only frozen plan. */
  function edit(world: BuildWorld, path: string, change: (value: Json) => void): void {
    const at = join(world.dir(SLUG), path);
    chmodSync(at, 0o644);
    const value = JSON.parse(readFileSync(at, "utf8")) as Json;
    change(value);
    writeFileSync(at, JSON.stringify(value, null, 2));
  }

  it("starts a medium plan with six tasks that 3.3 froze", async () => {
    const world = await buildWorld();
    await world.manager.freeze(freeze(planWith("large", 6)));
    // 3.3 froze plans with no task limit and no flow choice.
    let hash = "";
    edit(world, "plans/v1.json", (plan) => {
      plan.size = "medium";
      delete plan.flow;
      hash = planHash(BuildPlanSchema.parse(plan));
    });
    edit(world, "planning.json", (record) => {
      record.frozen[0]!.hash = hash;
      delete record.frozen[0]!.flow;
    });
    await world.restart();

    const started = await world.manager.start({ projectId: PROJECT_ID, slug: SLUG });
    expect(started.tasks).toHaveLength(6);
    await world.manager.cancel(SLUG);
  });

  it("still refuses a medium plan with six tasks that this version froze", async () => {
    const world = await buildWorld();
    await world.manager.freeze(freeze(planWith("large", 6)));
    let hash = "";
    edit(world, "plans/v1.json", (plan) => {
      plan.size = "medium";
      hash = planHash(BuildPlanSchema.parse(plan));
    });
    edit(world, "planning.json", (record) => {
      record.frozen[0]!.hash = hash;
    });
    await world.restart();

    await expect(world.manager.start({ projectId: PROJECT_ID, slug: SLUG })).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/at most 5 tasks/),
    });
  });

  it("resumes a running medium build with six tasks after an engine restart", async () => {
    const world = await buildWorld();
    await world.start(SLUG, planWith("large", 6));
    await world.manager.pause(SLUG);
    await world.waitFor(SLUG, (state) => state.status === "paused");
    edit(world, "plan.json", (plan) => {
      plan.size = "medium";
      delete plan.flow;
    });
    await world.restart();

    expect(await world.manager.get(SLUG)).toMatchObject({ status: "paused" });
    expect((await world.manager.resume(SLUG)).tasks).toHaveLength(6);
    await world.manager.cancel(SLUG);
  });
});
