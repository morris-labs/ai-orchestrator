// The Debugger (#73): two task gate failures in a row on one failure
// fingerprint seat the Debugger, read-only, and the Developer's next attempt
// gets its diagnosis.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CART_DONE, CART_WRONG, REPORT, buildWorld } from "./harness.js";

const DIAGNOSIS = {
  summary: "total() counts the items instead of adding their prices.",
  cause: "src/cart.mjs returns items.length.",
  fix: "Sum item.price over the items with reduce, starting from 0.",
  evidence: ["test/cart.test.mjs expects 5 for prices 2 and 3, and gets 2."],
};

/** A cart module that fails the test, the type check, and lint, unlike `CART_WRONG`. */
const CART_BROKEN = "export function total(items) {\n  console.log(items);\n  return (;\n}\n";

function isDebugger(prompt: string): boolean {
  return prompt.startsWith("You are the Debugger");
}

describe("the Debugger", () => {
  it("diagnoses a failure that repeats, and the Developer's next attempt gets the diagnosis", async () => {
    const world = await buildWorld();
    world.script({
      claude: [
        { match: "You are the Debugger", output: DIAGNOSIS },
        { match: "attempt 3 of", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } },
        { match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_WRONG } },
      ],
    });

    await world.start("cart-total");
    const state = await world.waitFor("cart-total", (s) => s.step === "review");

    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 3 });
    const calls = world.calls();
    expect(calls.map((c) => (isDebugger(c.prompt) ? "debugger" : "developer"))).toEqual([
      "developer",
      "developer",
      "debugger",
      "developer",
    ]);

    // The Debugger runs read-only, with the repeated failure in its prompt.
    const debug = calls[2];
    expect(debug?.argv).toEqual(expect.arrayContaining(["--permission-mode", "dontAsk"]));
    expect(debug?.argv.join(" ")).toMatch(/--disallowedTools \S*Edit/);
    expect(debug?.prompt).toContain("Don't change, create, or delete any file.");
    expect(debug?.prompt).toContain("node test/cart.test.mjs");
    const started = world.events.ofType("agent.started").map((e) => e.seat);
    expect(started).toEqual(["developer", "developer", "debugger", "developer"]);

    // The diagnosis is a file in the build.
    const diagnosis = JSON.parse(world.file("cart-total", "tasks/T1/diagnosis-2.json")) as Record<
      string,
      unknown
    >;
    expect(diagnosis).toMatchObject({
      attempt: 2,
      fingerprint: [expect.stringContaining("node test/cart.test.mjs")],
      answer: { output: DIAGNOSIS },
    });

    // The Developer's next prompt carries it.
    expect(calls[3]?.prompt).toContain(DIAGNOSIS.fix);
    expect(calls[3]?.prompt).toContain(DIAGNOSIS.cause);
    expect(calls[1]?.prompt).not.toContain(DIAGNOSIS.fix);
  });

  it("isn't seated when two failures in a row have different fingerprints", async () => {
    const world = await buildWorld();
    world.script({
      claude: [
        { match: "You are the Debugger", output: DIAGNOSIS },
        { match: "attempt 1 of", output: REPORT, writeFiles: { "src/cart.mjs": CART_WRONG } },
        { match: "attempt 2 of", output: REPORT, writeFiles: { "src/cart.mjs": CART_BROKEN } },
        { match: "attempt 3 of", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } },
      ],
    });

    await world.start("cart-total");
    const state = await world.waitFor("cart-total", (s) => s.step === "review");

    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 3 });
    expect(world.calls().filter((c) => isDebugger(c.prompt))).toEqual([]);
    for (const n of [1, 2]) {
      expect(existsSync(join(world.dir("cart-total"), `tasks/T1/diagnosis-${n}.json`))).toBe(false);
    }
  });

  it("continues after a restart without calling the Debugger again", async () => {
    const world = await buildWorld();
    world.script({
      claude: [
        { match: "You are the Debugger", output: DIAGNOSIS },
        // Attempt 3 is still running when the engine shuts down.
        { match: "attempt 3 of", delayMs: 10_000, output: REPORT },
        { match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_WRONG } },
      ],
    });
    await world.start("cart-total");
    await world.waitFor("cart-total", () =>
      existsSync(join(world.dir("cart-total"), "tasks/T1/attempt-3.json")),
    );
    world.script({
      claude: [
        { match: "You are the Debugger", output: DIAGNOSIS },
        { match: "attempt 3 of", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } },
      ],
    });
    await world.restart();

    await world.waitFor("cart-total", (s) => s.step === "review");

    expect(world.calls().filter((c) => isDebugger(c.prompt))).toHaveLength(1);
    expect(world.calls().at(-1)?.prompt).toContain(DIAGNOSIS.fix);
  });
});
