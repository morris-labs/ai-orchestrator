// An attempt cap after a set-aside (#98): a task fails its task gate, waits
// for an escalation while another task runs, gets its set-aside work back
// on a retry, and reaches its attempt cap. The build raises exactly one
// attempt cap escalation, starts no further Developer call for the task,
// and puts the escalation's pointer in the Project manager's inbox.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildPlanInput } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import {
  CART_STUB,
  CART_WRONG,
  PROJECT_ID,
  buildWorld,
  cartPlan,
  type BuildWorld,
} from "./harness.js";

const LABEL_STUB = 'export function label(name) {\n  return "";\n}\n';
const LABEL_DONE = "export function label(name) {\n  return `Item: ${name}`;\n}\n";

const DIAGNOSIS = {
  summary: "total() counts the items instead of adding their prices.",
  cause: "src/cart.mjs returns items.length.",
  fix: "Sum item.price over the items.",
  evidence: ["test/cart.test.mjs expects 5 and gets 2."],
};

/** Adds a label module stub and its test to the sample project. */
function addLabel(world: BuildWorld): void {
  writeFileSync(join(world.root, "src", "label.mjs"), LABEL_STUB);
  mkdirSync(join(world.root, "test"), { recursive: true });
  writeFileSync(
    join(world.root, "test", "label.test.mjs"),
    [
      'import assert from "node:assert/strict";',
      'import { label } from "../src/label.mjs";',
      'assert.equal(label("pen"), "Item: pen");',
      "",
    ].join("\n"),
  );
  world.git(world.root, "add", "-A");
  world.git(world.root, "commit", "-q", "-m", "feat: add a label stub");
}

/** T1, the cart total, and T2, the label, which doesn't depend on T1. */
function twoTaskPlan(): BuildPlanInput {
  return cartPlan({
    title: "Cart total and label",
    criteria: [
      { id: "AC1", text: "The cart reports the sum of its item prices." },
      { id: "AC2", text: "An item's label starts with Item:." },
    ],
    tasks: [
      {
        id: "T1",
        title: "Cart total",
        description: "Make total() return the sum of the item prices.",
        ownedFiles: ["src/cart.mjs"],
        criteria: ["AC1"],
        tests: ["test/cart.test.mjs"],
      },
      {
        id: "T2",
        title: "Label",
        description: "Make label() prefix the name with Item:.",
        ownedFiles: ["src/label.mjs"],
        criteria: ["AC2"],
        tests: ["test/label.test.mjs"],
      },
    ],
    commands: {
      test: [{ command: "node test/cart.test.mjs" }, { command: "node test/label.test.mjs" }],
      typecheck: [{ command: "node --check src/cart.mjs" }],
      lint: [{ command: "node lint.mjs" }],
    },
  });
}

const isDeveloperCallFor = (taskId: string) => (prompt: string) =>
  !prompt.startsWith("You are the Debugger") && new RegExp(`Task ${taskId}:`).test(prompt);

describe("an attempt cap after a set-aside", () => {
  it("escalates once with the attempt cap reason, starts no further call, and reaches the Project manager's inbox", async () => {
    const world = await buildWorld();
    addLabel(world);
    world.script({
      claude: [
        { match: "You are the Debugger", output: DIAGNOSIS },
        // Attempt 1 fails the task gate with work that the set-aside saves.
        {
          match: "Task T1:",
          times: 1,
          output: { summary: "Counted the items.", criteria: [{ id: "AC1", met: true }] },
          writeFiles: { "src/cart.mjs": CART_WRONG },
        },
        // Attempt 2 stops on a missing service, so T1 waits and T2 runs.
        {
          match: "Task T1:",
          times: 1,
          output: {
            summary: "Stopped: the price service is down.",
            criteria: [{ id: "AC1", met: false }],
            blocked: { kind: "service", name: "price-api", reason: "Connection refused." },
          },
        },
        {
          match: "Task T2:",
          output: { summary: "Added the label.", criteria: [{ id: "AC2", met: true }] },
          writeFiles: { "src/label.mjs": LABEL_DONE },
        },
        // Every later attempt changes nothing, so the brought-back work fails the gate.
        {
          match: "Task T1:",
          output: { summary: "No change.", criteria: [{ id: "AC1", met: true }] },
        },
      ],
    });

    await world.manager.start({
      projectId: PROJECT_ID,
      boxId: "box-pm",
      slug: "cart-label",
      plan: twoTaskPlan(),
    });
    const waiting = await world.settle("cart-label");

    // T1 waits for the owner; T2 finished on a worktree without T1's work.
    expect(waiting.status).toBe("waiting_escalation");
    expect(waiting.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T1", "failed", 2],
      ["T2", "done", 1],
    ]);
    expect(waiting.escalations).toEqual([
      expect.objectContaining({ id: "E1", kind: "missing_service", taskId: "T1" }),
    ]);
    const t2Commit = waiting.tasks.find((t) => t.id === "T2")?.commit ?? "";
    expect(world.git(waiting.worktree, "show", `${t2Commit}:src/cart.mjs`) + "\n").toBe(CART_STUB);
    expect(waiting.tasks[0]?.setAside).toBe("tasks/T1/set-aside-2.patch");
    expect(world.file("cart-label", "tasks/T1/set-aside-2.patch")).toContain(
      "return items.length;",
    );

    await world.manager.resolve("cart-label", { escalation: "E1", action: "retry", by: "owner" });
    const capped = await world.waitFor("cart-label", (s) => s.escalations.length === 2);
    const state = await world.settle("cart-label");

    // T1 got its set-aside work back and failed the gate up to its new cap.
    expect(readFileSync(join(capped.worktree, "src", "cart.mjs"), "utf8")).toBe(CART_WRONG);
    expect(state.status).toBe("waiting_escalation");
    expect(state.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T1", "failed", 6],
      ["T2", "done", 1],
    ]);

    // Exactly one attempt cap escalation, with the reason and the task named.
    const caps = (world.jsonFiles("cart-label", "escalations") as Record<string, unknown>[]).filter(
      (e) => e.kind === "attempt_cap",
    );
    expect(caps).toEqual([
      expect.objectContaining({
        id: "E2",
        kind: "attempt_cap",
        level: "project_manager",
        taskId: "T1",
        status: "open",
        summary: "Task T1 failed the task gate on all 6 attempts.",
      }),
    ]);
    expect(String(caps[0]?.details)).toContain("tasks/T1/attempt-6.json");

    // The engine sends the escalation's pointer to the Project manager's box once.
    const sent = world.events.ofType("build.inbox").filter((e) => e.item.ref === "E2");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ slug: "cart-label", boxId: "box-pm" });

    // No further Developer call for T1 starts, not even after an engine restart.
    const t1Calls = () => world.calls().filter((c) => isDeveloperCallFor("T1")(c.prompt)).length;
    expect(t1Calls()).toBe(6);
    await world.restart();
    // A waiting build sends no event after a restart, so wait on its state.
    await new Promise((r) => setTimeout(r, 300));
    const after = await world.waitFor("cart-label", (s) => s.status !== "running");
    expect(t1Calls()).toBe(6);
    expect(after.status).toBe("waiting_escalation");
    expect(after.escalations).toHaveLength(2);

    // The pointer waits in the Project manager's inbox until it's answered.
    const inbox = await world.manager.inbox("cart-label");
    expect(inbox.boxId).toBe("box-pm");
    const items = inbox.items.filter((i) => i.ref === "E2");
    expect(items).toEqual([
      expect.objectContaining({
        kind: "escalation",
        file: "escalations/E2.json",
        needsAnswer: true,
      }),
    ]);
    const file = join(world.dir("cart-label"), "escalations", "E2.json");
    expect(items[0]?.pointer).toMatch(/^\[aio-build cart-label I\d+\] .*T1.* Read /);
    expect(items[0]?.pointer.endsWith(`Read ${file}`)).toBe(true);
  });
});
