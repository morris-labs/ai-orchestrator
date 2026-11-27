// Planning through the engine build API: the Project manager calls the
// Analyst and the Architect, freezes the build plan, and starts the build
// from it, with the mock vendor CLIs.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BuildPlanSchema,
  BuildPlanningSchema,
  type BuildFlow,
  type BuildPlanInput,
  type BuildSeatRequestInput,
} from "@aio/contracts";
import { CART_DONE, PROJECT_ID, REPORT, buildWorld, cartPlan, type BuildWorld } from "./harness.js";

const SLUG = "cart-total";

/** What the Analyst answers: the spec. */
const SPEC = {
  title: "Add a total to the cart",
  summary: "Shoppers see what their cart costs.",
  stories: ["As a shopper, I want the cart's total, so that I know what I pay."],
  edgeCases: ["An empty cart totals zero."],
  criteria: [
    { id: "AC1", text: "The cart reports the sum of its item prices.", verification: "test" },
  ],
  size: "small",
  usageEstimate: { low: 100_000, high: 400_000 },
  secrets: [],
  services: [],
  recommendation: {
    flow: "single_session",
    highRisk: false,
    reason: "The change stays in the cart module and touches no stored data.",
  },
};

/** What the Architect answers: the design. */
const DESIGN = {
  architecture: "The cart module's `total()` sums the item prices.",
  sharedFiles: [],
  milestones: [{ id: "M1", title: "Cart total", goal: "The cart totals.", tasks: ["T1"] }],
  tasks: [
    {
      id: "T1",
      title: "Cart total",
      description: "Make total() return the sum of the item prices.",
      ownedFiles: ["src/cart.mjs"],
      criteria: ["AC1"],
      tests: ["test/cart.test.mjs"],
      specialties: ["node-dev"],
    },
  ],
};

function seat(seatName: string, extra: Partial<BuildSeatRequestInput> = {}) {
  return {
    projectId: PROJECT_ID,
    boxId: "box-1",
    slug: SLUG,
    seat: seatName,
    brief: "Add a total to the cart. The owner wants it on the cart page.",
    ...extra,
  };
}

/** A freeze request. The owner's flow choice is `pipeline` unless `extra` sets `flow`, even to `undefined`. */
function freeze(extra: { plan?: Record<string, unknown>; push?: boolean; flow?: BuildFlow } = {}) {
  return { projectId: PROJECT_ID, boxId: "box-1", slug: SLUG, flow: "pipeline" as const, ...extra };
}

/** A world whose repository has the `node-dev` specialty and the project's test commands in its policy. */
async function planningWorld(): Promise<BuildWorld> {
  const world = await buildWorld();
  mkdirSync(join(world.root, ".aio/team/specialties"), { recursive: true });
  writeFileSync(join(world.root, ".aio/team/specialties/node-dev.md"), "Use ES modules.\n");
  writeFileSync(
    join(world.root, ".aio/policy.yaml"),
    "version: 1\nsetup:\n  - command: node --version\ntests:\n  - command: node test/cart.test.mjs\nlint:\n  - command: node lint.mjs\n",
  );
  world.script({
    claude: [
      { match: "You are the Analyst", output: SPEC },
      { match: "You are the Architect", output: DESIGN },
      { match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } },
    ],
  });
  return world;
}

/** Calls the Analyst and the Architect. */
async function plan(world: BuildWorld, extra: Partial<BuildSeatRequestInput> = {}) {
  const analyst = await world.manager.plan(seat("analyst", extra));
  const architect = await world.manager.plan(seat("architect"));
  return { analyst, architect };
}

describe("planning a build", () => {
  it("calls the Analyst and the Architect and drafts a valid full build plan", async () => {
    const world = await planningWorld();
    const { analyst, architect } = await plan(world);

    expect(analyst.answer).toEqual(SPEC);
    expect(analyst.call).toMatchObject({ seat: "analyst", n: 1, status: "done" });
    expect(architect.answer).toEqual(DESIGN);
    const record = BuildPlanningSchema.parse(JSON.parse(world.file(SLUG, "planning.json")));
    expect(record.calls.map((c) => [c.seat, c.status])).toEqual([
      ["analyst", "done"],
      ["architect", "done"],
    ]);
    const draft = BuildPlanSchema.parse(JSON.parse(world.file(SLUG, "planning/draft.json")));
    expect(draft).toMatchObject({
      title: SPEC.title,
      size: "small",
      architecture: DESIGN.architecture,
      milestones: DESIGN.milestones,
      commands: {
        setup: [{ command: "node --version" }],
        test: [{ command: "node test/cart.test.mjs" }],
      },
      push: null,
    });
    expect(draft.tasks[0]?.specialties).toEqual(["node-dev"]);
    // The Architect hears the spec and the specialties it can name.
    const architectPrompt = world.calls().find((c) => c.prompt.includes("You are the Architect"));
    expect(architectPrompt?.prompt).toContain("node-dev");
    expect(architectPrompt?.prompt).toContain(SPEC.criteria[0]?.text);
    expect(world.file(SLUG, "STATUS.md")).toMatch(/planning/i);
  });

  it("reads the planning record of a build in planning, and none once it runs", async () => {
    const world = await planningWorld();
    expect(await world.manager.planning(SLUG)).toBeNull();
    await plan(world);

    expect(await world.manager.get(SLUG)).toBeNull();
    expect(await world.manager.planning(SLUG)).toMatchObject({
      slug: SLUG,
      calls: [{ seat: "analyst" }, { seat: "architect" }],
    });
    await world.manager.freeze(freeze({ push: false }));
    await world.manager.start({ projectId: PROJECT_ID, slug: SLUG });
    expect(await world.manager.planning(SLUG)).toBeNull();
  });

  it("keeps the Project manager's edits to the draft plan when a seat answers again", async () => {
    const world = await planningWorld();
    await plan(world);
    const draft = JSON.parse(world.file(SLUG, "planning/draft.json")) as Record<string, unknown>;
    // Without edits, the draft is the engine's.
    expect(JSON.parse(world.file(SLUG, "planning/draft.engine.json"))).toEqual(draft);
    writeFileSync(
      join(world.dir(SLUG), "planning/draft.json"),
      `${JSON.stringify({ ...draft, title: "Add a cart total with tax" }, null, 2)}\n`,
    );

    await world.manager.plan(seat("architect"));

    expect(JSON.parse(world.file(SLUG, "planning/draft.json"))).toMatchObject({
      title: "Add a cart total with tax",
    });
    // The engine's own draft from the latest answers is beside it.
    expect(JSON.parse(world.file(SLUG, "planning/draft.engine.json"))).toMatchObject({
      title: SPEC.title,
    });
  });

  it("holds planning seat calls while the build's box is stopped, and goes on when it starts", async () => {
    const world = await planningWorld();
    await world.manager.plan(seat("analyst"));
    const before = world.calls().length;

    expect(await world.manager.pausePlanning(SLUG)).toEqual({ paused: true });
    const architect = world.manager.plan(seat("architect"));
    await new Promise((r) => setTimeout(r, 300));
    expect(world.calls()).toHaveLength(before);

    expect(await world.manager.resumePlanning(SLUG)).toEqual({ paused: false });
    expect((await architect).answer).toEqual(DESIGN);
    expect(world.calls()).toHaveLength(before + 1);
  });

  it("keeps planning held for a stopped box across an engine restart", async () => {
    const world = await planningWorld();
    await world.manager.plan(seat("analyst"));
    await world.manager.pausePlanning(SLUG);
    expect(await world.manager.planning(SLUG)).toMatchObject({ pausedBy: "box" });
    const before = world.calls().length;

    await world.restart();
    const architect = world.manager.plan(seat("architect"));
    await new Promise((r) => setTimeout(r, 300));
    expect(world.calls()).toHaveLength(before);

    await world.manager.resumePlanning(SLUG);
    expect((await architect).answer).toEqual(DESIGN);
    expect((await world.manager.planning(SLUG))?.pausedBy).toBeUndefined();
  });

  it("runs the planning calls under leases that name the build, the seat, and the step", async () => {
    const world = await planningWorld();
    const { analyst } = await plan(world);

    const id = analyst.planning.id;
    expect(world.events.events[0]).toMatchObject({
      type: "build.changed",
      build: { id, slug: SLUG, projectId: PROJECT_ID, boxId: "box-1", status: "planning" },
    });
    expect(world.events.ofType("lease.settled").map((e) => [e.buildId, e.seat, e.step])).toEqual([
      [id, "analyst", "planning"],
      [id, "architect", "planning"],
    ]);
    expect(world.events.ofType("agent.finished")).toEqual([
      expect.objectContaining({ runId: null, buildId: id, seat: "analyst", role: "reviewer" }),
      expect.objectContaining({ runId: null, buildId: id, seat: "architect", role: "reviewer" }),
    ]);
  });

  it("refuses a seat whose role writes files", async () => {
    const world = await planningWorld();
    await expect(world.manager.plan(seat("developer"))).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/developer.*read-only/),
    });
  });

  it("refuses an Analyst answer that isn't a spec", async () => {
    const world = await planningWorld();
    world.script({ claude: [{ match: "You are the Analyst", output: { title: "Cart" } }] });
    await expect(world.manager.plan(seat("analyst"))).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/analyst.*spec/i),
    });
    const record = BuildPlanningSchema.parse(JSON.parse(world.file(SLUG, "planning.json")));
    expect(record.calls).toEqual([expect.objectContaining({ seat: "analyst", status: "failed" })]);
  });

  it("links a plan that starts from an issue back to it", async () => {
    const world = await planningWorld();
    await plan(world, { issue: { repository: "example/shop", number: 42 } });

    const { plan: frozen } = await world.manager.freeze(freeze({ push: true }));
    expect(frozen.issue).toEqual({
      repository: "example/shop",
      number: 42,
      url: "https://github.com/example/shop/issues/42",
    });
    expect(world.file(SLUG, "STATUS.md")).toContain("https://github.com/example/shop/issues/42");
    const analystPrompt = world.calls().find((c) => c.prompt.includes("You are the Analyst"));
    expect(analystPrompt?.prompt).toContain("https://github.com/example/shop/issues/42");
  });
});

describe("freezing the build plan", () => {
  it("refuses a freeze without the push answer and says to ask the owner", async () => {
    const world = await planningWorld();
    await plan(world);
    await expect(world.manager.freeze(freeze())).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/ask the owner/i),
    });
    expect(JSON.parse(world.file(SLUG, "planning.json")).frozen).toEqual([]);
  });

  it("freezes version 1 with the push answer, in a file the engine never changes", async () => {
    const world = await planningWorld();
    await plan(world);

    const answer = await world.manager.freeze(freeze({ push: false }));
    expect(answer.frozen).toMatchObject({ version: 1, file: "plans/v1.json", push: false });
    expect(answer.plan).toMatchObject({ version: 1, push: false });
    const file = join(world.dir(SLUG), "plans/v1.json");
    expect(BuildPlanSchema.parse(JSON.parse(world.file(SLUG, "plans/v1.json")))).toEqual(
      answer.plan,
    );
    expect(statSync(file).mode & 0o222).toBe(0);
  });

  it("keeps a version when a freeze changes nothing, and writes the next for a change", async () => {
    const world = await planningWorld();
    await plan(world);
    const v1 = await world.manager.freeze(freeze({ push: true }));
    const v1Text = world.file(SLUG, "plans/v1.json");

    const again = await world.manager.freeze(freeze({ push: true }));
    expect(again.frozen.version).toBe(1);

    const changed: BuildPlanInput = { ...v1.plan, title: "Add a cart total" };
    const v2 = await world.manager.freeze(freeze({ plan: changed }));
    expect(v2.frozen).toMatchObject({ version: 2, file: "plans/v2.json", push: true });
    expect(v2.plan.title).toBe("Add a cart total");
    expect(world.file(SLUG, "plans/v1.json")).toBe(v1Text);
    expect(v2.planning.frozen.map((f) => f.version)).toEqual([1, 2]);
  });

  it("freezes a plan the Project manager wrote itself, with no planning seats", async () => {
    const world = await planningWorld();
    const own: BuildPlanInput = {
      title: "Fix the cart total",
      criteria: [{ id: "AC1", text: "The cart reports the sum of its item prices." }],
      tasks: [
        {
          id: "T1",
          title: "Cart total",
          description: "Sum the prices.",
          ownedFiles: ["src/cart.mjs"],
          criteria: ["AC1"],
        },
      ],
      commands: { test: [{ command: "node test/cart.test.mjs" }] },
    };
    const answer = await world.manager.freeze(freeze({ plan: own, push: true }));
    expect(answer.frozen.version).toBe(1);
    expect(answer.planning.calls).toEqual([]);
    expect(world.calls()).toEqual([]);
  });

  it("refuses a frozen plan that names a specialty nobody has", async () => {
    const world = await planningWorld();
    await plan(world);
    const draft = JSON.parse(world.file(SLUG, "planning/draft.json")) as BuildPlanInput;
    const bad = { ...draft, tasks: draft.tasks.map((t) => ({ ...t, specialties: ["cobol-dev"] })) };
    await expect(world.manager.freeze(freeze({ plan: bad, push: true }))).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/cobol-dev/),
    });
  });
});

describe("starting a frozen build", () => {
  it("starts from the latest frozen version, under the build id its planning used", async () => {
    const world = await planningWorld();
    const { analyst } = await plan(world);
    await world.manager.freeze(freeze({ push: true }));

    const started = await world.manager.start({ projectId: PROJECT_ID, slug: SLUG });
    expect(started.id).toBe(analyst.planning.id);
    expect(started.title).toBe(SPEC.title);
    await world.settle(SLUG);
    expect(BuildPlanSchema.parse(JSON.parse(world.file(SLUG, "plan.json")))).toMatchObject({
      version: 1,
      push: true,
    });
    const leases = world.broker.requests.map((r) => r.leaseId);
    expect(new Set(leases).size).toBe(leases.length);
  });

  it("runs a small build from a plan the Project manager wrote, with no planning seat", async () => {
    const world = await planningWorld();
    await world.manager.freeze(freeze({ plan: cartPlan(), push: false }));

    await world.manager.start({ projectId: PROJECT_ID, slug: SLUG });
    const state = await world.settle(SLUG);

    const prompts = world.calls().map((c) => c.prompt);
    expect(prompts.some((p) => p.includes("Task T1"))).toBe(true);
    for (const seat of ["Analyst", "Architect", "Critic"])
      expect(prompts.some((p) => p.includes(`You are the ${seat}`))).toBe(false);
    const planning = BuildPlanningSchema.parse(JSON.parse(world.file(SLUG, "planning.json")));
    expect(planning.calls).toEqual([]);
    expect(planning.meetings).toEqual([]);
    expect(state.tasks[0]).toMatchObject({ id: "T1", status: "done" });
  });

  it("refuses a start without a box when the box its planning used runs another build", async () => {
    const world = await planningWorld();
    await world.manager.freeze(freeze({ plan: cartPlan(), push: false }));
    await world.manager.start({
      projectId: PROJECT_ID,
      boxId: "box-1",
      slug: "other-build",
      plan: cartPlan(),
    });

    await expect(world.manager.start({ projectId: PROJECT_ID, slug: SLUG })).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringMatching(/Box box-1 already runs the build other-build/),
    });
  });

  it("refuses a start whose plan differs from the frozen one", async () => {
    const world = await planningWorld();
    await plan(world);
    const { plan: frozen } = await world.manager.freeze(freeze({ push: true }));
    await expect(
      world.manager.start({ projectId: PROJECT_ID, slug: SLUG, plan: { ...frozen, title: "X" } }),
    ).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/freeze/i) });
  });

  it("refuses a start with no plan when nothing is frozen", async () => {
    const world = await planningWorld();
    await expect(world.manager.start({ projectId: PROJECT_ID, slug: SLUG })).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/frozen/),
    });
  });

  it("refuses a freeze and a seat call once the build runs", async () => {
    const world = await planningWorld();
    await plan(world);
    await world.manager.freeze(freeze({ push: true }));
    await world.manager.start({ projectId: PROJECT_ID, slug: SLUG });
    await world.settle(SLUG);
    await expect(world.manager.freeze(freeze({ push: false }))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(world.manager.plan(seat("analyst"))).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("the recommended flow", () => {
  it("records the Analyst's recommendation in the planning record, the status file, and the draft", async () => {
    const world = await planningWorld();
    await plan(world);

    const record = BuildPlanningSchema.parse(JSON.parse(world.file(SLUG, "planning.json")));
    expect(record.recommendation).toEqual(SPEC.recommendation);
    const status = world.file(SLUG, "STATUS.md");
    expect(status).toContain("Recommended flow: single session");
    expect(status).toContain("not high-risk");
    expect(status).toContain(SPEC.recommendation.reason);
    const draft = BuildPlanSchema.parse(JSON.parse(world.file(SLUG, "planning/draft.json")));
    expect(draft.recommendation).toEqual(SPEC.recommendation);
    expect(draft.flow).toBeNull();
    // The Analyst hears the size threshold and what counts as high-risk.
    const analystPrompt = world.calls().find((c) => c.prompt.includes("You are the Analyst"));
    expect(analystPrompt?.prompt).toContain("single_session");
    expect(analystPrompt?.prompt).toMatch(/migration/);
  });

  it("fails an Analyst answer whose recommendation breaks the size threshold", async () => {
    const world = await planningWorld();
    world.script({
      claude: [
        {
          match: "You are the Analyst",
          output: {
            ...SPEC,
            size: "medium",
            recommendation: { flow: "pipeline", highRisk: false, reason: "It is medium." },
          },
        },
      ],
    });
    await expect(world.manager.plan(seat("analyst"))).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/recommendation/),
    });
    const record = BuildPlanningSchema.parse(JSON.parse(world.file(SLUG, "planning.json")));
    expect(record.recommendation).toBeNull();
  });

  it("refuses a freeze without the owner's flow choice and names the recommendation", async () => {
    const world = await planningWorld();
    await plan(world);
    await expect(
      world.manager.freeze(freeze({ push: true, flow: undefined })),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/ask the owner.*single session.*--flow/is),
    });
    expect(JSON.parse(world.file(SLUG, "planning.json")).frozen).toEqual([]);
  });

  it("records the owner's override of the recommendation and runs a pipeline build", async () => {
    const world = await planningWorld();
    await plan(world);

    const answer = await world.manager.freeze(freeze({ push: false, flow: "pipeline" }));
    expect(answer.frozen.flow).toBe("pipeline");
    expect(answer.plan).toMatchObject({ flow: "pipeline", recommendation: SPEC.recommendation });
    expect(world.file(SLUG, "STATUS.md")).toMatch(/Version 1:.*Flow: pipeline/);

    await world.manager.start({ projectId: PROJECT_ID, slug: SLUG });
    await world.settle(SLUG);
    expect(BuildPlanSchema.parse(JSON.parse(world.file(SLUG, "plan.json"))).flow).toBe("pipeline");
    const status = world.file(SLUG, "STATUS.md");
    expect(status).toContain("- Flow: pipeline");
    expect(status).toContain("Recommended flow: single session");
  });

  it("records a single-session choice and starts the build in that flow", async () => {
    const world = await planningWorld();
    await plan(world);

    const answer = await world.manager.freeze(freeze({ push: false, flow: "single_session" }));
    expect(answer.frozen.flow).toBe("single_session");
    expect(answer.plan.flow).toBe("single_session");
    expect(world.file(SLUG, "STATUS.md")).toMatch(/Version 1:.*Flow: single session/);

    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });
    await world.manager.start({ projectId: PROJECT_ID, slug: SLUG });
    const state = await world.settle(SLUG);
    // The single-session flow skips the Contracts step and tests first.
    expect(state).toMatchObject({ step: "review", status: "paused" });
    expect(state.tasks).toEqual([expect.objectContaining({ id: "T1", status: "done" })]);
    const steps = world.events
      .ofType("build.changed")
      .filter((e) => e.build.id === state.id)
      .map((e) => e.build.step);
    expect(steps).not.toContain("contracts");
    expect(steps).not.toContain("tests_first");
    expect(world.file(SLUG, "STATUS.md")).toContain("- Flow: single session");
  });
});
