// Delivery to the Project manager (#82): each escalation and each milestone
// digest becomes one item in the build's inbox, with a one-line pointer to
// its file. The inbox lists what waits, across an engine restart, until the
// pointer is delivered and, for an escalation, until it's resolved.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CART_DONE, PROJECT_ID, REPORT, buildWorld, cartPlan } from "./harness.js";
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
