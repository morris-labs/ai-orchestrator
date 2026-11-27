// A mid-build plan amendment (#99): a task that must change a file outside
// its owned file set reaches its attempt cap, and the Project manager gives
// it the file with `own` on a retry or a clarification. The build then
// finishes release ready with the same build manager, so the amendment
// never needs an engine restart, as it did in the T2 measurement.
import type { BuildPlanInput } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { BUILD_PIPELINE } from "../../src/build/index.js";
import { buildWorld, cartPlan, type BuildWorld, type MockResponse } from "./harness.js";

type ResolveRequest = Parameters<BuildWorld["manager"]["resolve"]>[1];

const FORMAT = "export function price(amount) {\n  return amount.toFixed(2);\n}\n";
const CART = [
  'import { price } from "./format.mjs";',
  "export function total(items) {",
  "  return price(items.reduce((sum, item) => sum + item.price, 0));",
  "}",
  "",
].join("\n");

/** The locked test for AC1: it fails on an assertion against the cart stub. */
const PRICE_TEST = [
  "// AC1: the cart reports the sum of its item prices as a price.",
  'import assert from "node:assert/strict";',
  'import { total } from "../src/cart.mjs";',
  'assert.equal(total([{ price: 2 }, { price: 3 }]), "5.00");',
  "",
].join("\n");

const TEST_ENGINEER: MockResponse = {
  match: "round 1 of",
  output: {
    summary: "Wrote the tests first.",
    tests: [
      {
        file: "test/cart.test.mjs",
        name: "AC1: the cart reports the sum of its item prices as a price",
        criterion: "AC1",
        command: "node test/cart.test.mjs",
      },
    ],
  },
  writeFiles: { "test/cart.test.mjs": PRICE_TEST },
};

/** The Developer always needs the price formatter, which the plan gives no task. */
const DEVELOPER: MockResponse = {
  match: "Task T1",
  output: { summary: "Added the cart total as a price.", criteria: [{ id: "AC1", met: true }] },
  writeFiles: { "src/cart.mjs": CART, "src/format.mjs": FORMAT },
};

const DEBUGGER: MockResponse = {
  match: "You are the Debugger",
  output: {
    summary: "The task needs src/format.mjs, which it may not change.",
    cause: "The permission check puts src/format.mjs back after each attempt.",
    fix: "Give the task src/format.mjs.",
    evidence: ["The gate reports src/format.mjs outside the writable paths."],
  },
};

const SCRIBE: MockResponse = {
  match: "Task release",
  output: {
    summary: "Recorded the cart total.",
    pullRequest: { title: "feat(cart): show the cart total as a price", body: "Adds `total()`." },
    records: [{ path: "CHANGELOG.md", kind: "changelog" }],
  },
  writeFiles: { "CHANGELOG.md": "# Changelog\n\n- Show the cart total as a price.\n" },
};

const CLEAN_REVIEW: MockResponse = { output: { findings: [] } };

function pricePlan(): BuildPlanInput {
  return cartPlan({
    push: false,
    criteria: [{ id: "AC1", text: "The cart reports the sum of its item prices as a price." }],
  });
}

const RESOLUTIONS: { name: string; request: ResolveRequest & { note: string } }[] = [
  {
    name: "a retry",
    request: {
      escalation: "E1",
      action: "retry",
      own: ["src/format.mjs"],
      note: "The total needs the price formatter, which no task owns.",
    },
  },
  {
    name: "a clarification",
    request: {
      escalation: "E1",
      action: "clarify",
      own: ["src/format.mjs"],
      note: "Put the price formatter in src/format.mjs; the task owns it now.",
    },
  },
];

describe("a mid-build plan amendment of a task's owned files", () => {
  it.each(RESOLUTIONS)(
    "gives the task a file outside its owned set with $name and finishes release ready without a restart",
    async ({ request }) => {
      const world = await buildWorld({ steps: BUILD_PIPELINE, review: true, release: true });
      world.script({
        codex: [TEST_ENGINEER, SCRIBE, DEBUGGER, CLEAN_REVIEW],
        claude: [DEVELOPER, DEBUGGER, CLEAN_REVIEW],
      });
      const manager = world.manager;

      await world.start("cart-price", pricePlan());
      const waiting = await world.settle("cart-price");

      // Each attempt changed src/format.mjs, which the engine put back.
      expect(waiting).toMatchObject({ step: "tasks", status: "waiting_escalation" });
      expect(waiting.escalations).toEqual([
        expect.objectContaining({ id: "E1", kind: "attempt_cap", taskId: "T1", status: "open" }),
      ]);
      expect(world.file("cart-price", "escalations/E1.json")).toMatch(
        /outside the [a-z ]*paths[\s\S]*src\/format\.mjs/,
      );
      const before = world.calls().length;

      const resolved = await manager.resolve("cart-price", request);
      expect(resolved.escalations[0]).toMatchObject({
        status: "resolved",
        resolution: { action: request.action, own: ["src/format.mjs"] },
      });
      const state = await world.settle("cart-price");

      expect(state).toMatchObject({ step: "release_ready", status: "finished" });
      expect(state.tasks[0]).toMatchObject({ id: "T1", status: "done", attempts: 5 });
      const plan = JSON.parse(world.file("cart-price", "plan.json")) as BuildPlanInput;
      expect(plan.tasks?.[0]?.ownedFiles).toEqual(["src/cart.mjs", "src/format.mjs"]);
      // The retried Developer call may change the file, and its change stays.
      const retried = world
        .calls()
        .slice(before)
        .find((c) => c.prompt.includes("Task T1") && c.prompt.includes("attempt 5 of"));
      expect(retried?.prompt).toMatch(/## Owned files\n\n[^#]*src\/format\.mjs/);
      // The amendment gives the retry a fresh context pack that names the file.
      const packOf = (prompt = "") => /## Context pack\n[\s\S]*?(?=\n## |$)/.exec(prompt)?.[0];
      const first = world.calls().find((c) => c.prompt.includes("attempt 1 of"));
      expect(packOf(first?.prompt)).not.toContain("src/format.mjs");
      expect(packOf(retried?.prompt)).toContain("`src/format.mjs`: doesn't exist yet");
      // Only a clarification's note reaches the Developer.
      if (request.action === "clarify") expect(retried?.prompt).toContain(request.note);
      expect(world.git(world.root, "show", "build/cart-price:src/format.mjs")).toBe(FORMAT.trim());
      expect(world.git(world.root, "show", "build/cart-price:src/cart.mjs")).toBe(CART.trim());
      // The same build manager ran the whole build.
      expect(world.manager).toBe(manager);
    },
  );
});
