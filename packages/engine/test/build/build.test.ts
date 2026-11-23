// A one-task build through the engine build API, with the mock vendor CLIs.
import { describe, expect, it } from "vitest";
import { CART_DONE, REPORT, buildWorld } from "./harness.js";

describe("a one-task build", () => {
  it("reaches the review step with the Developer's commit on the build branch", async () => {
    const world = await buildWorld();
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });

    const started = await world.start("cart-total");
    expect(started).toMatchObject({ slug: "cart-total", branch: "build/cart-total" });
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review", status: "paused" });
    expect(state.tasks).toEqual([
      expect.objectContaining({ id: "T1", status: "done", attempts: 1 }),
    ]);
    const tip = world.git(world.root, "rev-parse", "build/cart-total");
    expect(state.tasks[0]?.commit).toBe(tip);
    expect(world.git(world.root, "show", "build/cart-total:src/cart.mjs")).toBe(CART_DONE.trim());
    expect(world.git(world.root, "rev-list", "--count", "main..build/cart-total")).toBe("1");
    expect(world.calls().map((c) => c.cli)).toEqual(["claude"]);
    expect(world.file("cart-total", "STATUS.md")).toMatch(/review/i);
  });

  it("leaves the project's own checkout untouched", async () => {
    const world = await buildWorld();
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }],
    });
    const head = world.git(world.root, "rev-parse", "HEAD");

    await world.start("cart-total");
    await world.settle("cart-total");

    expect(world.git(world.root, "rev-parse", "HEAD")).toBe(head);
    expect(world.git(world.root, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(world.git(world.root, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });
});
