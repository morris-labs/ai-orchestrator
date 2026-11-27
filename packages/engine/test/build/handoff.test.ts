// The Project manager hand-off (#104): at each milestone end, the engine
// writes a hand-off file with the plan state, the open escalations, the
// owner's decisions, the defaulted answers, and the usage to date, and the
// Project manager's inbox gets a pointer that tells it to start a fresh
// session from that file.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildPlanInput } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { CART_DONE, PROJECT_ID, buildWorld, cartPlan, type BuildWorld } from "./harness.js";

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

/**
 * Two milestones in the opposite order of the tasks: T1 runs first but
 * belongs to M2, so an escalation on T1 is still open when M1 ends.
 */
function plan(): BuildPlanInput {
  return cartPlan({
    title: "Cart total and label",
    size: "medium",
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
      { id: "M1", title: "Labels", goal: "Items have labels.", tasks: ["T2"] },
      { id: "M2", title: "Cart total", goal: "The cart adds up its prices.", tasks: ["T1"] },
    ],
    defaultedAnswers: [
      { question: "Which currency does the total use?", answer: "The prices' own unit." },
    ],
    push: false,
    commands: {
      test: [{ command: "node test/cart.test.mjs" }, { command: "node test/label.test.mjs" }],
      typecheck: [{ command: "node --check src/cart.mjs" }],
      lint: [{ command: "node lint.mjs" }],
    },
  });
}

describe("the Project manager hand-off", () => {
  it("writes a hand-off file at each milestone end and points the Project manager to a fresh session from it", async () => {
    const world = await buildWorld();
    addLabel(world);
    world.script({
      claude: [
        {
          match: "Task T1",
          times: 1,
          output: {
            summary: "Stopped: the price service is down.",
            criteria: [{ id: "AC1", met: false }],
            blocked: { kind: "service", name: "price-api", reason: "Connection refused." },
          },
          tokens: { input: 500, output: 50 },
        },
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
      slug: "cart-handoff",
      plan: plan(),
    });
    const waiting = await world.settle("cart-handoff");
    expect(waiting.escalations).toEqual([
      expect.objectContaining({ id: "E1", kind: "missing_service", status: "open" }),
    ]);

    // M1 ended while E1 waits: the hand-off follows the milestone's digest.
    let inbox = await world.manager.inbox("cart-handoff", { all: true });
    expect(inbox.items.map((i) => [i.kind, i.ref, i.file, i.needsAnswer])).toEqual([
      ["escalation", "E1", "escalations/E1.json", true],
      ["digest", "milestone-M1", "digests/milestone-M1.md", false],
      ["handoff", "milestone-M1", "handoffs/milestone-M1.md", false],
    ]);
    const pointer = inbox.items[2]?.pointer ?? "";
    expect(pointer).toMatch(
      /^\[aio-build cart-handoff I3\] Start a fresh Project manager session from this hand-off file: milestone M1 \(Labels\) is done, and milestone M2 \(Cart total\) is next\. Read .*handoffs\/milestone-M1\.md$/,
    );
    expect(pointer.endsWith(join(world.dir("cart-handoff"), "handoffs", "milestone-M1.md"))).toBe(
      true,
    );

    const m1 = world.file("cart-handoff", "handoffs/milestone-M1.md");
    expect(m1).toContain("# Hand-off after milestone M1 of build cart-handoff: Labels");
    expect(m1).toContain("Next: milestone M2 (Cart total).");
    expect(m1).toContain(join(world.dir("cart-handoff"), "digests", "milestone-M1.md"));
    // The five parts, in order.
    const headings = [...m1.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      "Plan state",
      "Open escalations",
      "Owner decisions",
      "Defaulted answers",
      "Usage to date",
    ]);
    expect(m1).toContain("- M1 Labels: done.");
    expect(m1).toContain("- M2 Cart total: 0 of 1 task done.");
    expect(m1).toContain("- T1 Cart total (M2): failed in 1 attempt.");
    expect(m1).toContain("- T2 Label (M1): done in 1 attempt");
    expect(m1).toMatch(/- E1 \(missing_service, for the owner\): .*price-api.* Read .*E1\.json/);
    expect(m1).toContain("Push answer: no.");
    expect(m1).toContain(
      "- Which currency does the total use? Defaulted to: The prices' own unit.",
    );
    expect(m1).toContain("| developer | 2 | 2500 | 250 |");

    await world.manager.resolve("cart-handoff", {
      escalation: "E1",
      action: "retry",
      by: "owner",
      note: "The price service is back.",
    });
    await world.waitFor("cart-handoff", (s) => s.step === "review");
    await world.settle("cart-handoff");

    inbox = await world.manager.inbox("cart-handoff", { all: true });
    expect(inbox.items.slice(3).map((i) => [i.kind, i.ref])).toEqual([
      ["digest", "milestone-M2"],
      ["handoff", "milestone-M2"],
    ]);
    expect(inbox.items[4]?.pointer).toContain(
      "milestone M2 (Cart total) is done, and the review and release steps are next.",
    );

    const m2 = world.file("cart-handoff", "handoffs/milestone-M2.md");
    expect(m2).toContain("Next: the review and release steps.");
    expect(m2).toContain("- M2 Cart total: done.");
    expect(m2).toContain("- T1 Cart total (M2): done in 2 attempts");
    expect(m2).toMatch(/## Open escalations\n\nNone\./);
    expect(m2).toContain('- E1: the owner answered with retry: "The price service is back."');
    // The usage counts every settled call since the build started.
    expect(m2).toContain("| developer | 3 | 3500 | 350 |");
    expect(m2).toContain("| Total | 3 | 3500 | 350 |");
  });
});
