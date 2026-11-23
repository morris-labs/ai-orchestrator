// Preflight and the test baseline (#70): the engine checks that the build
// plan's commands run, records the known failing and flaky tests from three
// test runs, and the task gate doesn't fail an attempt for them.
import { describe, expect, it } from "vitest";
import { REPORT, buildWorld, cartPlan } from "./harness.js";

describe("preflight", () => {
  it.each([
    ["test", { test: [{ command: "node test/cart.test.mjs" }, { command: "no-such-runner" }] }],
    ["typecheck", { typecheck: [{ command: "no-such-checker --strict" }] }],
    ["lint", { lint: [{ command: "node lint.mjs", cwd: "missing-dir" }] }],
  ])(
    "stops a plan whose %s command can't run with an escalation that names it",
    async (_kind, commands) => {
      const world = await buildWorld();
      world.script({ claude: [{ match: "Task T1", output: REPORT }] });
      const plan = cartPlan();
      plan.commands = { ...plan.commands, ...commands };
      const named = Object.values(commands)[0]?.at(-1)?.command ?? "";

      await world.start("cart-total", plan);
      const state = await world.settle("cart-total");

      expect(state).toMatchObject({ status: "waiting_escalation", step: "preflight" });
      expect(state.escalations).toEqual([
        expect.objectContaining({ kind: "preflight", taskId: null, level: "project_manager" }),
      ]);
      expect(state.escalations[0]?.summary).toContain(named);
      const [escalation] = world.jsonFiles("cart-total", "escalations") as Record<
        string,
        unknown
      >[];
      expect(escalation).toMatchObject({ step: "preflight", details: expect.stringContaining(named) });
      expect(world.calls()).toHaveLength(0);
      expect(state.tasks[0]).toMatchObject({ status: "pending", attempts: 0 });
    },
  );
});
