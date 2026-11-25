// The Contracts step through the engine build API: in a medium or large
// build, a Developer writes the plan's contract files with stubs before tests
// first, and the task gate holds the stubs to the plan's checks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BuildPlanInput, BuildStep } from "@aio/contracts";
import { CART_STUB, buildWorld, cartPlan, type MockResponse } from "./harness.js";

const STEPS: readonly BuildStep[] = ["preflight", "contracts"];

/** The contract file of the discount task. */
const DISCOUNT = "src/discount.mjs";
/** The discount contract: the real signature, with a stub body. */
const DISCOUNT_STUB = "export function discount(total, code) {\n  return total;\n}\n";

/** A medium plan whose second task implements the discount contract. */
function discountPlan(overrides: Partial<BuildPlanInput> = {}): BuildPlanInput {
  const base = cartPlan();
  return {
    ...base,
    title: "Add discount codes to the cart",
    size: "medium",
    criteria: [
      ...base.criteria,
      { id: "AC2", text: "A discount code takes 10 percent off the total." },
    ],
    tasks: [
      ...(base.tasks ?? []),
      {
        id: "T2",
        title: "Discount codes",
        description: "Make discount() take 10 percent off for the code SAVE10.",
        ownedFiles: [DISCOUNT, "test/discount.test.mjs"],
        contracts: [DISCOUNT],
        criteria: ["AC2"],
        tests: ["test/discount.test.mjs"],
        dependsOn: ["T1"],
      },
    ],
    ...overrides,
  };
}

const CONTRACTS_REPORT = { summary: "Added the discount contract with a stub.", criteria: [] };

/** A Developer answer for attempt `n` of the Contracts step. */
function contractsAttempt(n: number, files: Record<string, string>): MockResponse {
  return {
    match: `attempt ${n} of 4 of the Contracts step`,
    output: CONTRACTS_REPORT,
    writeFiles: files,
  };
}

describe("the Contracts step", () => {
  it("has a Developer write the contract files with stubs, and commits them before tests first", async () => {
    const world = await buildWorld({ steps: STEPS });
    world.script({ claude: [contractsAttempt(1, { [DISCOUNT]: DISCOUNT_STUB })] });

    await world.start("discount", discountPlan());
    const state = await world.settle("discount");

    expect(state.status).toBe("finished");
    expect(world.events.ofType("agent.started")).toEqual([
      expect.objectContaining({ seat: "developer", step: "contracts" }),
    ]);
    const [call] = world.calls();
    expect(call?.prompt).toContain(`- ${DISCOUNT}`);
    expect(call?.prompt).toMatch(/stub/i);
    expect(world.git(state.worktree, "log", "-1", "--format=%s")).toBe(
      "feat(build): add the contracts for Add discount codes to the cart",
    );
    expect(world.git(state.worktree, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(state.worktree, DISCOUNT), "utf8")).toBe(DISCOUNT_STUB);
    expect(state.contracts).toEqual({
      status: "done",
      attempts: 1,
      commit: world.git(state.worktree, "rev-parse", "HEAD"),
    });
    expect(world.file("discount", "STATUS.md")).toContain("- Contracts: done after 1 attempt");
  });

  it("skips a small build and a plan without contract files", async () => {
    const world = await buildWorld({ steps: STEPS });

    await world.start("small", discountPlan({ size: "small" }));
    await world.start("none", cartPlan({ size: "medium" }));
    const small = await world.settle("small");
    const none = await world.settle("none");

    expect(world.calls()).toEqual([]);
    expect(small).toMatchObject({ status: "finished", contracts: { status: "skipped" } });
    expect(none).toMatchObject({ status: "finished", contracts: { status: "skipped" } });
    expect(world.file("small", "STATUS.md")).toContain("- Contracts: skipped");
  });

  it("sends a failed gate back to the Developer with its report", async () => {
    const world = await buildWorld({ steps: STEPS });
    world.script({
      claude: [
        contractsAttempt(1, {
          [DISCOUNT]: DISCOUNT_STUB,
          "src/cart.mjs": "export function total(items) {\n",
        }),
        contractsAttempt(2, { [DISCOUNT]: DISCOUNT_STUB, "src/cart.mjs": CART_STUB }),
      ],
    });

    await world.start("discount", discountPlan());
    const state = await world.settle("discount");

    expect(state).toMatchObject({ status: "finished", contracts: { status: "done", attempts: 2 } });
    const second = world.calls()[1]?.prompt ?? "";
    expect(second).toContain("The gate failed the last attempt");
    expect(second).toContain("node --check src/cart.mjs");
  });

  it("refuses a change to a test path and puts it back", async () => {
    const world = await buildWorld({ steps: STEPS });
    world.script({
      claude: [
        contractsAttempt(1, { [DISCOUNT]: DISCOUNT_STUB, "test/discount.test.mjs": "// AC2\n" }),
        contractsAttempt(2, { [DISCOUNT]: DISCOUNT_STUB }),
      ],
    });

    await world.start("discount", discountPlan());
    const state = await world.settle("discount");

    expect(state).toMatchObject({ status: "finished", contracts: { status: "done", attempts: 2 } });
    expect(world.calls()[1]?.prompt).toContain("test/discount.test.mjs");
    expect(world.git(state.worktree, "ls-files", "test/discount.test.mjs")).toBe("");
  });

  it("escalates to the Project manager after the last attempt, and a retry gets more attempts", async () => {
    const world = await buildWorld({ steps: STEPS });
    const broken = { [DISCOUNT]: "export function discount(total, code) {\n" };
    // The plan's type check reads the discount stub, which every attempt breaks.
    const plan = discountPlan({
      commands: {
        test: [{ command: "node test/cart.test.mjs" }],
        typecheck: [{ command: `node --check ${DISCOUNT}` }],
        lint: [],
      },
    });
    world.script({
      claude: [1, 2, 3, 4].map((n) => contractsAttempt(n, broken)),
    });

    await world.start("discount", plan);
    const state = await world.settle("discount");

    expect(state).toMatchObject({
      status: "waiting_escalation",
      step: "contracts",
      contracts: { status: "failed", attempts: 4 },
    });
    expect(state.escalations).toEqual([
      expect.objectContaining({ kind: "contracts", level: "project_manager", taskId: null }),
    ]);

    world.script({
      claude: [{ ...contractsAttempt(5, { [DISCOUNT]: DISCOUNT_STUB }), match: "attempt 5 of 8" }],
    });
    await world.manager.resolve("discount", { escalation: "E1", action: "retry" });
    const after = await world.settle("discount");
    expect(after).toMatchObject({
      status: "finished",
      contracts: { status: "done", attempts: 5 },
    });
  });
});
