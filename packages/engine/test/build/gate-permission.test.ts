// The task gate's permission check: changed paths outside the seat's
// writable globs fail it, except paths exempted by their exact name.
import { describe, expect, it } from "vitest";
import { outsideWritable } from "../../src/build/gate.js";

describe("outsideWritable", () => {
  it("matches writable paths as globs and exempt paths literally", () => {
    const changed = ["src/cart.mjs", "notes/*.md", "notes/dev.md", "test/[a].mjs", "test/a.mjs"];

    expect(outsideWritable(changed, ["src/*.mjs"], ["notes/*.md", "test/[a].mjs"])).toEqual([
      "notes/dev.md",
      "test/a.mjs",
    ]);
  });
});
