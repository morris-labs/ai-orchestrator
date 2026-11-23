import { describe, expect, it } from "vitest";
import {
  BUILD_SOCKET_ROUTES,
  BuildDesignSchema,
  BuildIssueSchema,
  BuildPlanSchema,
  BuildPlanningSchema,
  BuildSocketFreezeSchema,
  BuildSocketPlanSchema,
  BuildSocketStartSchema,
  BuildSpecSchema,
  draftBuildPlan,
} from "../src/index.js";
import { roundTrip } from "./helpers.js";

/** What an Analyst answers: the spec. */
export const analystAnswer = {
  title: "Add a total to the cart",
  summary: "Shoppers see what their cart costs before they check out.",
  stories: ["As a shopper, I want the cart's total, so that I know what I pay."],
  edgeCases: ["An empty cart totals zero."],
  criteria: [
    { id: "AC1", text: "The cart reports the sum of its item prices.", verification: "test" },
    { id: "AC2", text: "The cart page shows the total.", verification: "owner" },
  ],
  size: "small",
  usageEstimate: { low: 200_000, high: 600_000 },
  secrets: [{ name: "SHOP_API_TOKEN", purpose: "Reads prices from the shop's API." }],
  services: [{ name: "Shop API", purpose: "The source of item prices." }],
};

/** What an Architect answers: the architecture, milestones, and task graph. */
export const architectAnswer = {
  architecture: "The cart module gains a `total()` function that sums item prices.",
  sharedFiles: ["src/types.mjs"],
  milestones: [
    { id: "M1", title: "Cart total", goal: "The cart reports its total.", tasks: ["T1"] },
  ],
  tasks: [
    {
      id: "T1",
      title: "Cart total",
      description: "Make total() return the sum of the item prices.",
      ownedFiles: ["src/cart.mjs"],
      criteria: ["AC1", "AC2"],
      tests: ["test/cart.test.mjs"],
      specialties: ["node-dev"],
    },
  ],
};

const commands = { test: [{ command: "node test/cart.test.mjs" }] };

describe("the planning seats' answers", () => {
  it("accepts an Analyst's spec", () => {
    const spec = roundTrip(BuildSpecSchema, analystAnswer);
    expect(spec.criteria.map((c) => c.verification)).toEqual(["test", "owner"]);
    expect(spec.size).toBe("small");
  });

  it("refuses a spec criterion without a verification method", () => {
    const bad = { ...analystAnswer, criteria: [{ id: "AC1", text: "The cart totals." }] };
    expect(() => BuildSpecSchema.parse(bad)).toThrow(/verification/);
  });

  it("refuses a usage estimate whose low end is over its high end", () => {
    const bad = { ...analystAnswer, usageEstimate: { low: 9, high: 1 } };
    expect(() => BuildSpecSchema.parse(bad)).toThrow(/low/);
  });

  it("accepts an Architect's design with specialties on its tasks", () => {
    const design = roundTrip(BuildDesignSchema, architectAnswer);
    expect(design.tasks[0]?.specialties).toEqual(["node-dev"]);
  });

  it("refuses a milestone that names a task the design doesn't have", () => {
    const bad = {
      ...architectAnswer,
      milestones: [{ id: "M1", title: "Cart", goal: "Totals.", tasks: ["T9"] }],
    };
    expect(() => BuildDesignSchema.parse(bad)).toThrow(/T9/);
  });
});

describe("the full build plan", () => {
  it("validates a plan drafted from the Analyst's and the Architect's answers", () => {
    const draft = draftBuildPlan(
      BuildSpecSchema.parse(analystAnswer),
      BuildDesignSchema.parse(architectAnswer),
      { commands },
    );
    const plan = roundTrip(BuildPlanSchema, draft);
    expect(plan).toMatchObject({
      title: "Add a total to the cart",
      spec: {
        summary: analystAnswer.summary,
        stories: analystAnswer.stories,
        edgeCases: analystAnswer.edgeCases,
      },
      size: "small",
      usageEstimate: { low: 200_000, high: 600_000 },
      secrets: analystAnswer.secrets,
      services: analystAnswer.services,
      architecture: architectAnswer.architecture,
      sharedFiles: ["src/types.mjs"],
      milestones: architectAnswer.milestones,
      push: null,
      issue: null,
    });
    expect(plan.criteria.map((c) => c.id)).toEqual(["AC1", "AC2"]);
    expect(plan.tasks[0]?.specialties).toEqual(["node-dev"]);
  });

  it("records the issue a plan starts from, with a link back to it", () => {
    const draft = draftBuildPlan(
      BuildSpecSchema.parse(analystAnswer),
      BuildDesignSchema.parse(architectAnswer),
      { commands, issue: { repository: "example/shop", number: 42 }, push: true },
    );
    const plan = BuildPlanSchema.parse(draft);
    expect(plan.issue).toEqual({
      repository: "example/shop",
      number: 42,
      url: "https://github.com/example/shop/issues/42",
    });
    expect(plan.push).toBe(true);
  });

  it("keeps an issue link that the request gives", () => {
    const issue = BuildIssueSchema.parse({
      repository: "example/shop",
      number: 7,
      url: "https://git.example.com/example/shop/issues/7",
    });
    expect(issue.url).toBe("https://git.example.com/example/shop/issues/7");
  });

  it("refuses an issue outside the owner/name form", () => {
    expect(() => BuildIssueSchema.parse({ repository: "shop", number: 1 })).toThrow(/owner/);
  });

  it("refuses a milestone that names a task the plan doesn't have", () => {
    const draft = draftBuildPlan(
      BuildSpecSchema.parse(analystAnswer),
      BuildDesignSchema.parse(architectAnswer),
      { commands },
    );
    const bad = { ...draft, milestones: [{ id: "M1", title: "x", goal: "y", tasks: ["T4"] }] };
    expect(() => BuildPlanSchema.parse(bad)).toThrow(/T4/);
  });
});

describe("the planning record", () => {
  it("round-trips a record with a seat call and a frozen version", () => {
    roundTrip(BuildPlanningSchema, {
      version: 1,
      id: "01JB0000000000000000000000",
      slug: "cart-total",
      projectId: "proj-1",
      boxId: "box-1",
      container: "aio-agent-proj-1",
      repoPath: "/work/shop",
      issue: null,
      calls: [
        {
          key: "plan-analyst-1",
          seat: "analyst",
          n: 1,
          status: "done",
          file: "planning/analyst-1.json",
          startedAt: "2026-11-23T09:00:00.000Z",
          finishedAt: "2026-11-23T09:05:00.000Z",
        },
      ],
      frozen: [
        {
          version: 1,
          file: "plans/v1.json",
          hash: "a".repeat(64),
          push: true,
          frozenAt: "2026-11-23T09:10:00.000Z",
        },
      ],
      createdAt: "2026-11-23T09:00:00.000Z",
      updatedAt: "2026-11-23T09:10:00.000Z",
    });
  });
});

describe("the planning requests on the build socket", () => {
  it("routes a seat call and a freeze", () => {
    expect(BUILD_SOCKET_ROUTES).toMatchObject({
      plan: "/v1/builds/plan",
      freeze: "/v1/builds/freeze",
    });
  });

  it("takes a seat, a brief, and an optional issue", () => {
    const request = BuildSocketPlanSchema.parse({
      projectId: "proj-1",
      boxId: null,
      slug: "cart-total",
      seat: "analyst",
      brief: "Add a total to the cart.",
      issue: { repository: "example/shop", number: 42 },
    });
    expect(request.issue?.url).toBe("https://github.com/example/shop/issues/42");
  });

  it("takes a freeze with or without a plan and a push answer", () => {
    expect(
      BuildSocketFreezeSchema.parse({ projectId: "p", boxId: null, slug: "cart-total" }),
    ).toEqual({ projectId: "p", boxId: null, slug: "cart-total" });
    expect(
      BuildSocketFreezeSchema.parse({ projectId: "p", boxId: null, slug: "s", push: false }).push,
    ).toBe(false);
  });

  it("starts a build without a plan, from its frozen plan", () => {
    expect(
      BuildSocketStartSchema.parse({ projectId: "p", boxId: null, slug: "cart-total" }),
    ).not.toHaveProperty("plan");
  });
});
