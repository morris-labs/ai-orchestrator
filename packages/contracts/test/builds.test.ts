import { describe, expect, it } from "vitest";
import { BuildCreateSchema, BuildPlanSchema, BuildStateSchema, BUILDS_DIR } from "../src/index.js";
import { roundTrip } from "./helpers.js";

const plan = {
  title: "Add a total to the cart",
  criteria: [{ id: "AC1", text: "The cart reports the sum of its item prices." }],
  tasks: [
    {
      id: "T1",
      title: "Cart total",
      description: "Add a total() function to the cart module.",
      ownedFiles: ["src/cart.mjs"],
      criteria: ["AC1"],
      tests: ["test/cart.test.mjs"],
    },
  ],
  commands: {
    test: [{ command: "node --test" }],
    lint: [{ command: "node lint.mjs" }],
  },
};

describe("BuildPlanSchema", () => {
  it("accepts a one-task plan and fills the defaults", () => {
    const parsed = roundTrip(BuildPlanSchema, plan);
    expect(parsed.version).toBe(1);
    expect(parsed.criteria[0]).toMatchObject({ verification: "test", alreadyHolds: false });
    expect(parsed.tasks[0]).toMatchObject({ role: "developer", contracts: [], specialties: [] });
    expect(parsed.commands.typecheck).toEqual([]);
    expect(parsed).toMatchObject({ singleVendor: null, placements: {}, size: "medium" });
  });

  it("takes a small, medium, or large build size", () => {
    expect(BuildPlanSchema.parse({ ...plan, size: "small" }).size).toBe("small");
    expect(() => BuildPlanSchema.parse({ ...plan, size: "huge" })).toThrow(/size/);
  });

  it("refuses a task that names a criterion the plan doesn't have", () => {
    const bad = { ...plan, tasks: [{ ...plan.tasks[0], criteria: ["AC9"] }] };
    expect(() => BuildPlanSchema.parse(bad)).toThrow(/AC9/);
  });

  it("refuses two criteria with one ID", () => {
    const bad = { ...plan, criteria: [plan.criteria[0], plan.criteria[0]] };
    expect(() => BuildPlanSchema.parse(bad)).toThrow(/AC1/);
  });

  it("refuses a plan with more than one task", () => {
    const bad = { ...plan, tasks: [plan.tasks[0], { ...plan.tasks[0], id: "T2" }] };
    expect(() => BuildPlanSchema.parse(bad)).toThrow(/one task/);
  });

  it("refuses an unknown field", () => {
    expect(() => BuildPlanSchema.parse({ ...plan, speed: "fast" })).toThrow(/speed/);
  });

  it("refuses a plan with no test command", () => {
    const bad = { ...plan, commands: { test: [] } };
    expect(() => BuildPlanSchema.parse(bad)).toThrow(/test/);
  });
});

describe("BuildCreateSchema", () => {
  it("takes a kebab-case slug and a plan", () => {
    const parsed = BuildCreateSchema.parse({ projectId: "p-1", slug: "cart-total", plan });
    expect(parsed.slug).toBe("cart-total");
    expect(() => BuildCreateSchema.parse({ projectId: "p-1", slug: "Cart Total", plan })).toThrow(
      /regex|Invalid/,
    );
  });
});

describe("BuildStateSchema", () => {
  it("round-trips a running build", () => {
    roundTrip(BuildStateSchema, {
      version: 1,
      id: "01JD0000000000000000000000",
      slug: "cart-total",
      projectId: "p-1",
      boxId: null,
      container: "aio-agent-proj-shop",
      title: "Add a total to the cart",
      repoPath: "/workspace/shop",
      base: "0123456789abcdef0123456789abcdef01234567",
      branch: "build/cart-total",
      worktree: "/workspace/shop/.worktrees/build-cart-total",
      status: "running",
      step: "tasks",
      tasks: [{ id: "T1", status: "running", attempts: 1, commit: null }],
      escalations: [],
      placements: { singleVendor: null, plan: {}, live: [] },
      createdAt: "2026-11-23T09:00:00.000Z",
      updatedAt: "2026-11-23T09:00:00.000Z",
    });
  });

  it("keeps build files beside the run files", () => {
    expect(BUILDS_DIR).toBe(".aio/builds");
  });
});
