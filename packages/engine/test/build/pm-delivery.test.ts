// Delivery to the Project manager (#82): each escalation and each milestone
// digest becomes one item in the build's inbox, with a one-line pointer to
// its file. The inbox lists what waits, across an engine restart, until the
// pointer is delivered and, for an escalation, until it's resolved.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CART_DONE, PROJECT_ID, REPORT, buildWorld, cartPlan, type BuildWorld } from "./harness.js";
import { tempDir } from "../tmp.js";

/** A test command that can't run (exit 127) until `marker` exists. */
function gatedTest(marker: string) {
  const plan = cartPlan();
  plan.commands = {
    ...plan.commands,
    test: [{ command: `test -f ${marker} || exit 127; node test/cart.test.mjs` }],
  };
  return plan;
}

describe("the Project manager inbox", () => {
  it("holds one pointer for an escalation until it's delivered and resolved, across a restart", async () => {
    const world = await buildWorld();
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });
    const marker = join(tempDir("aio-marker-"), "ready");

    await world.manager.start({
      projectId: PROJECT_ID,
      boxId: "box-pm",
      slug: "cart-total",
      plan: gatedTest(marker),
    });
    await world.settle("cart-total");

    const inbox = await world.manager.inbox("cart-total");
    expect(inbox).toMatchObject({ slug: "cart-total", boxId: "box-pm" });
    expect(inbox.items).toHaveLength(1);
    const [item] = inbox.items;
    const file = join(world.dir("cart-total"), "escalations", "E1.json");
    expect(item).toMatchObject({
      id: "I1",
      kind: "escalation",
      ref: "E1",
      file: "escalations/E1.json",
      path: file,
      needsAnswer: true,
      deliveredAt: null,
      answeredAt: null,
    });
    expect(item?.pointer).toMatch(/^\[aio-build cart-total I1\] .*can't run\..* Read /);
    expect(item?.pointer.endsWith(`Read ${file}`)).toBe(true);
    expect(item?.pointer).not.toContain("\n");
    const sent = world.events.ofType("build.inbox");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ slug: "cart-total", boxId: "box-pm", item: { id: "I1" } });

    await world.restart();
    expect((await world.manager.inbox("cart-total")).items.map((i) => i.id)).toEqual(["I1"]);

    const delivered = await world.manager.delivered("cart-total", "I1");
    expect(delivered.deliveredAt).not.toBeNull();
    expect((await world.manager.delivered("cart-total", "I1")).deliveredAt).toBe(
      delivered.deliveredAt,
    );
    // Delivered, but the escalation still waits for an answer.
    expect((await world.manager.inbox("cart-total")).items.map((i) => i.id)).toEqual(["I1"]);
    await expect(world.manager.delivered("cart-total", "I9")).rejects.toMatchObject({
      code: "not_found",
    });

    writeFileSync(marker, "");
    await world.manager.resolve("cart-total", { escalation: "E1", action: "retry" });
    await world.waitFor("cart-total", (s) => s.step === "review");
    await world.settle("cart-total");

    const all = await world.manager.inbox("cart-total", { all: true });
    expect(all.items[0]).toMatchObject({ id: "I1", answeredAt: expect.any(String) });
    const waiting = await world.manager.inbox("cart-total");
    expect(waiting.items.map((i) => i.ref)).not.toContain("E1");
    expect(existsSync(join(world.dir("cart-total"), "inbox.json"))).toBe(true);
  });
});

const LABEL_STUB = 'export function label(name) {\n  return "";\n}\n';
const LABEL_DONE = "export function label(name) {\n  return `Item: ${name}`;\n}\n";

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

/** Two milestones: the cart total, then the label. */
function twoMilestonePlan() {
  return cartPlan({
    title: "Cart total and label",
    criteria: [
      { id: "AC1", text: "The cart reports the sum of its item prices." },
      { id: "AC2", text: "An item label names the item." },
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
        description: "Make label() name the item.",
        ownedFiles: ["src/label.mjs"],
        criteria: ["AC2"],
        tests: ["test/label.test.mjs"],
      },
    ],
    milestones: [
      { id: "M1", title: "Cart total", goal: "The cart adds up its prices.", tasks: ["T1"] },
      { id: "M2", title: "Labels", goal: "Items have labels.", tasks: ["T2"] },
    ],
    commands: {
      test: [{ command: "node test/cart.test.mjs" }, { command: "node test/label.test.mjs" }],
      typecheck: [{ command: "node --check src/cart.mjs" }],
      lint: [{ command: "node lint.mjs" }],
    },
  });
}

describe("milestone digests", () => {
  it("writes a digest with the usage of each milestone when its tasks are done, and points the Project manager to it", async () => {
    const world = await buildWorld();
    addLabel(world);
    world.script({
      claude: [
        {
          match: "Task T1",
          output: { summary: "Added the total.", criteria: [{ id: "AC1", met: true }] },
          writeFiles: { "src/cart.mjs": CART_DONE },
          tokens: { input: 1000, output: 100 },
        },
        {
          match: "Task T2",
          output: { summary: "Added the label.", criteria: [{ id: "AC2", met: true }] },
          writeFiles: { "src/label.mjs": LABEL_DONE },
          tokens: { input: 2000, output: 200 },
        },
      ],
    });

    await world.manager.start({
      projectId: PROJECT_ID,
      boxId: "box-pm",
      slug: "cart-label",
      plan: twoMilestonePlan(),
    });
    await world.settle("cart-label");

    const inbox = await world.manager.inbox("cart-label");
    expect(inbox.items.map((i) => [i.kind, i.ref, i.file, i.needsAnswer])).toEqual([
      ["digest", "milestone-M1", "digests/milestone-M1.md", false],
      ["digest", "milestone-M2", "digests/milestone-M2.md", false],
    ]);
    expect(inbox.items[0]?.pointer).toMatch(
      /^\[aio-build cart-label I1\] Milestone M1 \(Cart total\) is done: 1 of 2 milestones\..* Read .*digests\/milestone-M1\.md$/,
    );

    const m1 = world.file("cart-label", "digests/milestone-M1.md");
    expect(m1).toContain("# Milestone M1 of build cart-label: Cart total");
    expect(m1).toContain("- T1 Cart total: done in 1 attempt");
    expect(m1).toContain("| developer | 1 | 1000 | 100 |");
    expect(m1).toContain("| Total | 1 | 1000 | 100 |");
    expect(m1).not.toContain("T2");
    const m2 = world.file("cart-label", "digests/milestone-M2.md");
    expect(m2).toContain("| developer | 1 | 2000 | 200 |");
    expect(m2).toContain("2 of 2 milestones");

    // Delivered digests no longer wait: they need no answer.
    for (const item of inbox.items) await world.manager.delivered("cart-label", item.id);
    expect((await world.manager.inbox("cart-label")).items).toEqual([]);

    // Each task change names the task's milestone, so the board groups it.
    const changes = world.events
      .ofType("build.task.changed")
      .map((e) => [e.taskId, e.status, e.milestone]);
    expect(changes).toContainEqual(["T1", "running", "M1"]);
    expect(changes).toContainEqual(["T1", "done", "M1"]);
    expect(changes).toContainEqual(["T2", "done", "M2"]);
  });
});
