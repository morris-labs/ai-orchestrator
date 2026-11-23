// Escalations (#74): an escalation pauses only the task it names and the
// tasks that depend on it, independent tasks go on, and a resolve request
// resumes what it paused and records how it was resolved.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BuildPlanInput, Escalation } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import {
  CART_DONE,
  CART_WRONG,
  REPORT,
  buildWorld,
  cartPlan,
  type BuildWorld,
  type MockResponse,
} from "./harness.js";

const DISCOUNT_STUB = "export function discounted(items, percent) {\n  return 0;\n}\n";
const DISCOUNT_DONE = [
  'import { total } from "./cart.mjs";',
  "export function discounted(items, percent) {",
  "  return (total(items) * (100 - percent)) / 100;",
  "}",
  "",
].join("\n");
const LABEL_STUB = 'export function label(name) {\n  return "";\n}\n';
const LABEL_DONE = "export function label(name) {\n  return `Item: ${name}`;\n}\n";

const DIAGNOSIS = {
  summary: "total() counts the items instead of adding their prices.",
  cause: "src/cart.mjs returns items.length.",
  fix: "Sum item.price over the items.",
  evidence: ["test/cart.test.mjs expects 5 and gets 2."],
};

/** Adds a discount module, which needs the cart total, and a label module, which needs nothing. */
function addModules(world: BuildWorld): void {
  const files: Record<string, string> = {
    "src/discount.mjs": DISCOUNT_STUB,
    "src/label.mjs": LABEL_STUB,
    "test/discount.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { discounted } from "../src/discount.mjs";',
      "assert.equal(discounted([{ price: 10 }, { price: 10 }], 10), 18);",
      "",
    ].join("\n"),
    "test/label.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { label } from "../src/label.mjs";',
      'assert.equal(label("pen"), "Item: pen");',
      "",
    ].join("\n"),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(world.root, path)), { recursive: true });
    writeFileSync(join(world.root, path), content);
  }
  world.git(world.root, "add", "-A");
  world.git(world.root, "commit", "-q", "-m", "feat: add discount and label stubs");
}

const task = (id: string, title: string, module: string, dependsOn: string[] = []) => ({
  id,
  title,
  description: `Implement ${module}.`,
  ownedFiles: [`src/${module}.mjs`],
  criteria: [`AC-${id}`],
  tests: [`test/${module}.test.mjs`],
  dependsOn,
});

/** T2 needs T1; T3 needs nothing. */
function threeTaskPlan(): BuildPlanInput {
  return cartPlan({
    title: "Cart total, discount, and label",
    criteria: ["T1", "T2", "T3"].map((id) => ({ id: `AC-${id}`, text: `Task ${id} works.` })),
    tasks: [
      task("T1", "Cart total", "cart"),
      task("T2", "Discount", "discount", ["T1"]),
      task("T3", "Label", "label"),
    ],
    commands: {
      test: ["cart", "discount", "label"].map((m) => ({ command: `node test/${m}.test.mjs` })),
      typecheck: [{ command: "node --check src/cart.mjs" }],
      lint: [{ command: "node lint.mjs" }],
    },
  });
}

const answer = (id: string, files: Record<string, string>, match = `Task ${id}`): MockResponse => ({
  match,
  output: { summary: `Did ${id}.`, criteria: [{ id: `AC-${id}`, met: true }] },
  writeFiles: files,
});

const taskOf = (prompt: string) =>
  prompt.startsWith("You are the Debugger") ? "D" : (/Task (T\d):/.exec(prompt)?.[1] ?? "?");

function escalationFile(world: BuildWorld, slug: string, id: string): Record<string, unknown> {
  return JSON.parse(world.file(slug, `escalations/${id}.json`)) as Record<string, unknown>;
}

describe("an escalation that pauses only what it affects", () => {
  it("lets an independent task finish while a task waits, then resumes the task and its dependents on a retry", async () => {
    const world = await buildWorld();
    addModules(world);
    world.script({
      claude: [
        { match: "You are the Debugger", output: DIAGNOSIS },
        answer("T1", { "src/cart.mjs": CART_DONE }, "attempt 5 of"),
        answer("T1", { "src/cart.mjs": CART_WRONG }),
        answer("T2", { "src/discount.mjs": DISCOUNT_DONE }),
        answer("T3", { "src/label.mjs": LABEL_DONE }),
      ],
    });

    await world.start("checkout", threeTaskPlan());
    const waiting = await world.settle("checkout");

    // T1 reached its attempt cap; T2 waits with it; T3 finished meanwhile.
    expect(waiting.status).toBe("waiting_escalation");
    expect(waiting.tasks.map((t) => [t.id, t.status])).toEqual([
      ["T1", "failed"],
      ["T2", "blocked"],
      ["T3", "done"],
    ]);
    expect(waiting.escalations).toEqual([
      expect.objectContaining({
        id: "E1",
        kind: "attempt_cap",
        level: "project_manager",
        taskId: "T1",
        tasks: ["T1", "T2"],
        status: "open",
      }),
    ]);
    expect(world.calls().map((c) => taskOf(c.prompt))).not.toContain("T2");
    expect(world.file("checkout", "STATUS.md")).toMatch(/E1 \(attempt_cap.*open.*pauses T1, T2/);

    const resumed = await world.manager.resolve("checkout", {
      escalation: "E1",
      action: "retry",
      note: "Retry after the stale fixture was fixed.",
    });
    expect(resumed.status).toBe("running");
    const state = await world.waitFor("checkout", (s) => s.step === "review");

    expect(state.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T1", "done", 5],
      ["T2", "done", 1],
      ["T3", "done", 1],
    ]);
    const calls = world.calls().map((c) => taskOf(c.prompt));
    expect(calls.slice(-2)).toEqual(["T1", "T2"]);
    // The resolution is recorded in the state and the escalation file.
    const resolved: Escalation | undefined = state.escalations[0];
    expect(resolved).toMatchObject({
      status: "resolved",
      resolution: {
        action: "retry",
        by: "project_manager",
        note: "Retry after the stale fixture was fixed.",
        resolvedAt: expect.any(String),
      },
    });
    expect(escalationFile(world, "checkout", "E1")).toMatchObject({
      status: "resolved",
      resolution: { action: "retry" },
    });
  });
});

describe("a resolution while other tasks run", () => {
  it("resumes the paused task after the running task, in the same drive's wake", async () => {
    const world = await buildWorld();
    addModules(world);
    world.script({
      claude: [
        { match: "Task T1", times: 2, error: "boom" },
        answer("T1", { "src/cart.mjs": CART_DONE }),
        answer("T2", { "src/discount.mjs": DISCOUNT_DONE }),
        { ...answer("T3", { "src/label.mjs": LABEL_DONE }), delayMs: 1500 },
      ],
    });

    await world.start("checkout", threeTaskPlan());
    // T3 starts once T1 escalates, and its slow answer keeps the drive busy.
    const running = await world.waitFor(
      "checkout",
      (s) => s.escalations.length === 1 && s.tasks.find((t) => t.id === "T3")?.status === "running",
    );
    expect(running.status).toBe("running");
    expect(running.tasks.find((t) => t.id === "T1")?.status).toBe("failed");

    const resumed = await world.manager.resolve("checkout", { escalation: "E1", action: "retry" });
    expect(resumed.status).toBe("running");
    const state = await world.waitFor("checkout", (s) => s.step === "review");

    expect(state.tasks.map((t) => [t.id, t.status])).toEqual([
      ["T1", "done"],
      ["T2", "done"],
      ["T3", "done"],
    ]);
    expect(state.escalations).toHaveLength(1);
  });
});

describe("escalation levels", () => {
  it("lists the diagnosis files in an attempt cap escalation for the Project manager", async () => {
    const world = await buildWorld();
    world.script({
      claude: [
        { match: "You are the Debugger", output: DIAGNOSIS },
        { match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_WRONG } },
      ],
    });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state.escalations[0]).toMatchObject({ kind: "attempt_cap", level: "project_manager" });
    expect(escalationFile(world, "cart-total", "E1").details).toContain(
      "Diagnosis files: tasks/T1/diagnosis-2.json, tasks/T1/diagnosis-3.json",
    );
  });

  it("escalates a secret that the project doesn't give the build to the owner at preflight, and goes on after a retry", async () => {
    let names = ["GH_TOKEN"];
    const world = await buildWorld({ secretNames: () => Promise.resolve(names) });
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });
    const plan = cartPlan({
      secrets: [{ name: "SHOP_API_KEY", purpose: "Reads the price list." }],
    });

    await world.start("cart-total", plan);
    const waiting = await world.settle("cart-total");

    expect(waiting).toMatchObject({ status: "waiting_escalation", step: "preflight" });
    expect(waiting.escalations).toEqual([
      expect.objectContaining({
        kind: "missing_secret",
        level: "owner",
        taskId: null,
        tasks: [],
        summary: expect.stringContaining("SHOP_API_KEY"),
      }),
    ]);
    expect(world.calls()).toEqual([]);

    // Only the owner can resolve it.
    await expect(
      world.manager.resolve("cart-total", { escalation: "E1", action: "retry" }),
    ).rejects.toThrow(/waits for the owner/);
    names = ["GH_TOKEN", "SHOP_API_KEY"];
    await world.manager.resolve("cart-total", { escalation: "E1", action: "retry", by: "owner" });
    const state = await world.waitFor("cart-total", (s) => s.step === "review");

    expect(state.tasks[0]).toMatchObject({ status: "done" });
    expect(state.escalations[0]).toMatchObject({
      status: "resolved",
      resolution: { action: "retry", by: "owner" },
    });
  });

  it("escalates a task whose seat reports a missing service to the owner, and lets the other tasks finish", async () => {
    const world = await buildWorld();
    addModules(world);
    world.script({
      claude: [
        {
          match: "Task T1",
          times: 1,
          output: {
            summary: "Stopped: the price service is down.",
            criteria: [{ id: "AC-T1", met: false }],
            blocked: { kind: "service", name: "price-api", reason: "Connection refused." },
          },
        },
        answer("T1", { "src/cart.mjs": CART_DONE }),
        answer("T2", { "src/discount.mjs": DISCOUNT_DONE }),
        answer("T3", { "src/label.mjs": LABEL_DONE }),
      ],
    });

    await world.start("checkout", threeTaskPlan());
    const waiting = await world.settle("checkout");

    expect(waiting.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T1", "failed", 1],
      ["T2", "blocked", 0],
      ["T3", "done", 1],
    ]);
    expect(waiting.escalations).toEqual([
      expect.objectContaining({
        kind: "missing_service",
        level: "owner",
        taskId: "T1",
        tasks: ["T1", "T2"],
        summary: expect.stringContaining("price-api"),
      }),
    ]);
    // The gate didn't run for the attempt that stopped.
    expect(world.jsonFiles("checkout", "tasks/T1")[0]).not.toHaveProperty("gate");

    await world.manager.resolve("checkout", { escalation: "E1", action: "retry", by: "owner" });
    const state = await world.waitFor("checkout", (s) => s.step === "review");
    expect(state.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T1", "done", 2],
      ["T2", "done", 1],
      ["T3", "done", 1],
    ]);
  });
});

describe("resolutions", () => {
  /** A one-task build whose Developer fails once and then asks for a decision. */
  async function capped(world: BuildWorld, slug = "cart-total") {
    world.script({
      claude: [
        { match: "You are the Debugger", output: DIAGNOSIS },
        answer("T1", { "src/cart.mjs": CART_DONE }, "attempt 5 of"),
        answer("T1", { "src/cart.mjs": CART_WRONG }),
      ],
    });
    const plan = cartPlan({
      criteria: [{ id: "AC-T1", text: "The cart reports the sum of its item prices." }],
      tasks: [task("T1", "Cart total", "cart")],
    });
    await world.start(slug, plan);
    return world.settle(slug);
  }

  it("marks a change to the criteria for the owner instead of resolving it, and the owner resolves it", async () => {
    const world = await buildWorld();
    await capped(world);

    const marked = await world.manager.resolve("cart-total", {
      escalation: "E1",
      action: "clarify",
      note: "Count the quantity of each item too.",
      changes: ["criteria"],
    });

    expect(marked.status).toBe("waiting_escalation");
    expect(marked.escalations[0]).toMatchObject({
      level: "owner",
      status: "open",
      ownerReason: expect.stringMatching(/changes the criteria, which only the owner decides/),
    });
    expect(escalationFile(world, "cart-total", "E1")).toMatchObject({ level: "owner" });
    expect(world.file("cart-total", "STATUS.md")).toMatch(/E1 \(attempt_cap, for the owner/);

    await world.manager.resolve("cart-total", {
      escalation: "E1",
      action: "retry",
      by: "owner",
      note: "Keep the criteria as they are.",
    });
    const state = await world.waitFor("cart-total", (s) => s.step === "review");
    expect(state.escalations[0]).toMatchObject({ status: "resolved", resolution: { by: "owner" } });
  });

  it("resolves an escalation after an engine restart, and the build goes on", async () => {
    const world = await buildWorld();
    await capped(world);

    await world.restart();
    expect((await world.manager.get("cart-total"))?.status).toBe("waiting_escalation");
    const resumed = await world.manager.resolve("cart-total", {
      escalation: "E1",
      action: "retry",
    });
    expect(resumed.status).toBe("running");
    const state = await world.waitFor("cart-total", (s) => s.step === "review");

    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 5 });
    expect(state.escalations[0]).toMatchObject({ status: "resolved" });
  });

  it("hands an escalation to the owner when the Project manager escalates it", async () => {
    const world = await buildWorld();
    await capped(world);

    const state = await world.manager.resolve("cart-total", {
      escalation: "E1",
      action: "escalate",
      note: "The task may need a bigger change than the plan allows.",
    });

    expect(state.escalations[0]).toMatchObject({
      level: "owner",
      status: "open",
      ownerReason: "The task may need a bigger change than the plan allows.",
    });
  });

  it("puts a clarification in the task's next attempt", async () => {
    const world = await buildWorld();
    await capped(world);

    await world.manager.resolve("cart-total", {
      escalation: "E1",
      action: "clarify",
      note: "total() sums item.price; items have no quantity.",
    });
    await world.waitFor("cart-total", (s) => s.step === "review");

    const retry = world.calls().find((c) => c.prompt.includes("attempt 5 of 8"));
    expect(retry?.prompt).toContain("total() sums item.price; items have no quantity.");
  });

  it("refuses a request that doesn't fit the escalation, and a second resolution", async () => {
    const world = await buildWorld();
    await capped(world);
    const resolve = (request: Parameters<BuildWorld["manager"]["resolve"]>[1]) =>
      world.manager.resolve("cart-total", request);

    await expect(resolve({ escalation: "E9", action: "retry" })).rejects.toThrow(
      /no escalation E9/,
    );
    await expect(resolve({ escalation: "E1", action: "clarify" })).rejects.toThrow(/needs note/);
    await expect(
      resolve({ escalation: "E1", action: "decide", decision: { option: "resume" } }),
    ).rejects.toThrow(/isn't about a review run/);
    await expect(resolve({ escalation: "E1", action: "reorder", order: ["T9"] })).rejects.toThrow(
      /no task T9/,
    );
    await resolve({ escalation: "E1", action: "retry" });
    await expect(resolve({ escalation: "E1", action: "retry" })).rejects.toThrow(
      /resolved already/,
    );
  });

  it("runs the tasks in a new order after a reorder, and refuses one that breaks a dependency", async () => {
    const world = await buildWorld();
    addModules(world);
    world.script({
      claude: [
        { match: "Task T1", times: 1, error: "boom" },
        { match: "Task T1", times: 1, error: "boom" },
        answer("T1", { "src/cart.mjs": CART_DONE }),
        answer("T2", { "src/discount.mjs": DISCOUNT_DONE }),
        answer("T3", { "src/label.mjs": LABEL_DONE }),
      ],
    });
    const plan = threeTaskPlan();
    plan.tasks = [
      ...plan.tasks.slice(0, 2),
      { ...task("T3", "Label", "label"), dependsOn: ["T1"] },
    ];

    await world.start("checkout", plan);
    const waiting = await world.settle("checkout");
    expect(waiting.escalations[0]).toMatchObject({ kind: "agent_call", tasks: ["T1", "T2", "T3"] });

    await expect(
      world.manager.resolve("checkout", {
        escalation: "E1",
        action: "reorder",
        order: ["T3", "T1", "T2"],
      }),
    ).rejects.toThrow(/T3 depends on T1/);
    await world.manager.resolve("checkout", {
      escalation: "E1",
      action: "reorder",
      order: ["T1", "T3", "T2"],
    });
    const state = await world.waitFor("checkout", (s) => s.step === "review");

    expect(state.taskOrder).toEqual(["T1", "T3", "T2"]);
    const order = world
      .calls()
      .map((c) => taskOf(c.prompt))
      .filter((t) => t !== "T1");
    expect(order).toEqual(["T3", "T2"]);
  });
});

describe("resolutions for each step", () => {
  it("resumes an oscillating task with a clarification while an independent task finishes", async () => {
    const world = await buildWorld();
    addModules(world);
    const broken = { "src/discount.mjs": DISCOUNT_DONE, "src/cart.mjs": CART_WRONG };
    world.script({
      claude: [
        { match: "You are the Debugger", output: DIAGNOSIS },
        answer("T1", { "src/cart.mjs": CART_DONE }),
        {
          ...answer("T2", { "src/discount.mjs": DISCOUNT_DONE, "src/cart.mjs": CART_DONE }),
          match: "attempt 3 of 6",
        },
        answer("T2", broken),
        answer("T3", { "src/label.mjs": LABEL_DONE }),
      ],
    });
    const plan = threeTaskPlan();
    plan.tasks = plan.tasks.map((t) =>
      t.id === "T2" ? { ...t, ownedFiles: ["src/discount.mjs", "src/cart.mjs"] } : t,
    );

    await world.start("checkout", plan);
    const waiting = await world.settle("checkout");

    expect(waiting.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T1", "done", 1],
      ["T2", "failed", 2],
      ["T3", "done", 1],
    ]);
    expect(waiting.escalations).toEqual([
      expect.objectContaining({ kind: "oscillation", level: "project_manager", tasks: ["T2"] }),
    ]);

    await world.manager.resolve("checkout", {
      escalation: "E1",
      action: "clarify",
      note: "Leave total() alone; the discount builds on it.",
    });
    const state = await world.waitFor("checkout", (s) => s.step === "review");

    expect(state.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T1", "done", 1],
      ["T2", "done", 3],
      ["T3", "done", 1],
    ]);
    const retry = world.calls().find((c) => c.prompt.includes("attempt 3 of 6"));
    expect(retry?.prompt).toContain("Leave total() alone; the discount builds on it.");
  });

  it("checks the commands again after a preflight escalation is retried", async () => {
    const world = await buildWorld();
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });
    const plan = cartPlan();
    plan.commands = { ...plan.commands, lint: [{ command: "./check.sh" }] };

    await world.start("cart-total", plan);
    const waiting = await world.settle("cart-total");
    expect(waiting).toMatchObject({ status: "waiting_escalation", step: "preflight" });
    expect(waiting.escalations[0]).toMatchObject({ kind: "preflight", tasks: [] });

    // The Project manager adds the missing script to the build branch.
    const script = join(waiting.worktree, "check.sh");
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o755);
    world.git(waiting.worktree, "add", "check.sh");
    world.git(waiting.worktree, "commit", "-q", "-m", "build: add the lint check");
    await world.manager.resolve("cart-total", { escalation: "E1", action: "retry" });
    const state = await world.waitFor("cart-total", (s) => s.step === "review");

    expect(state.tasks[0]).toMatchObject({ status: "done" });
    expect(state.escalations[0]).toMatchObject({ status: "resolved" });
  });

  it("pauses only the task whose specialty can't be loaded, and loads it again on a retry", async () => {
    const world = await buildWorld();
    addModules(world);
    const pack = join(world.root, ".aio", "team", "specialties", "labels.md");
    mkdirSync(dirname(pack), { recursive: true });
    writeFileSync(pack, "Prefix every label with its kind.\n");
    world.script({
      claude: [
        { ...answer("T1", { "src/cart.mjs": CART_DONE }), delayMs: 300 },
        answer("T2", { "src/discount.mjs": DISCOUNT_DONE }),
        answer("T3", { "src/label.mjs": LABEL_DONE }),
      ],
    });
    const plan = threeTaskPlan();
    plan.tasks = plan.tasks.map((t) => (t.id === "T3" ? { ...t, specialties: ["labels"] } : t));

    await world.start("checkout", plan);
    // The pack loses its guidance after the plan check, before T3's call.
    writeFileSync(pack, "");
    const waiting = await world.settle("checkout");

    expect(waiting.tasks.map((t) => [t.id, t.status])).toEqual([
      ["T1", "done"],
      ["T2", "done"],
      ["T3", "failed"],
    ]);
    expect(waiting.escalations).toEqual([
      expect.objectContaining({ kind: "specialty", taskId: "T3", tasks: ["T3"] }),
    ]);

    writeFileSync(pack, "Prefix every label with its kind.\n");
    await world.manager.resolve("checkout", { escalation: "E1", action: "retry" });
    const state = await world.waitFor("checkout", (s) => s.step === "review");

    expect(state.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T1", "done", 1],
      ["T2", "done", 1],
      ["T3", "done", 1],
    ]);
    const labelled = world.calls().filter((c) => taskOf(c.prompt) === "T3");
    expect(labelled.at(-1)?.prompt).toContain("Prefix every label with its kind.");
  });
});

describe("a box stop beside an escalation", () => {
  it("pauses the tasks that go on beside an escalation, and a resolution waits for the box start", async () => {
    const world = await buildWorld();
    addModules(world);
    world.script({
      claude: [
        { match: "Task T1", times: 2, error: "boom" },
        answer("T1", { "src/cart.mjs": CART_DONE }),
        answer("T2", { "src/discount.mjs": DISCOUNT_DONE }),
        { ...answer("T3", { "src/label.mjs": LABEL_DONE }), delayMs: 1500 },
      ],
    });
    await world.start("checkout", threeTaskPlan());
    await world.waitFor(
      "checkout",
      (s) => s.escalations.length === 1 && s.tasks.find((t) => t.id === "T3")?.status === "running",
    );

    expect(await world.manager.pause("checkout", "box")).toMatchObject({
      status: "paused",
      pausedBy: "box",
    });
    const held = await world.manager.resolve("checkout", { escalation: "E1", action: "retry" });
    expect(held).toMatchObject({ status: "paused", pausedBy: "box" });
    expect(held.escalations[0]).toMatchObject({ status: "resolved" });
    await new Promise((r) => setTimeout(r, 1800));
    const paused = await world.manager.get("checkout");
    expect(paused?.status).toBe("paused");
    expect(world.calls().filter((c) => taskOf(c.prompt) === "T1")).toHaveLength(2);

    await world.manager.resume("checkout", "box");
    const state = await world.waitFor("checkout", (s) => s.step === "review");
    expect(state.tasks.map((t) => [t.id, t.status])).toEqual([
      ["T1", "done"],
      ["T2", "done"],
      ["T3", "done"],
    ]);
  });

  it("holds a build that waits for an escalation for a box stop, and the box start puts it back to waiting", async () => {
    const world = await buildWorld();
    const plan = cartPlan();
    plan.commands = { ...plan.commands, lint: [{ command: "./check.sh" }] };
    world.script({ claude: [{ match: "Task T1", output: REPORT }] });
    await world.start("cart-total", plan);
    await world.settle("cart-total");

    expect(await world.manager.pause("cart-total", "box")).toMatchObject({
      status: "paused",
      pausedBy: "box",
    });
    const resumed = await world.manager.resume("cart-total", "box");

    // The open preflight escalation still holds the build, and preflight doesn't run again.
    expect(resumed).toMatchObject({ status: "waiting_escalation", step: "preflight" });
    expect(resumed.pausedBy).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    expect((await world.manager.get("cart-total"))?.escalations).toHaveLength(1);
  });
});
