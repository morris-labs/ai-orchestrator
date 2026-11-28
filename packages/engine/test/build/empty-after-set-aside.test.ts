// A test command that finds no test files once the gate set aside a later
// task's tests. Test runners such as Vitest exit non-zero on an empty run,
// so a workspace package whose tests all belong to later tasks fails the
// whole suite command. That failure says nothing about the task under the
// gate, so it doesn't fail the gate, and the repository needs no
// `passWithNoTests` setting.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BuildPlanInput } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import type { TaskGateResult } from "../../src/build/index.js";
import { CART_DONE, CART_WRONG, buildWorld, cartPlan, type BuildWorld } from "./harness.js";

const DISCOUNT_STUB = "export function discounted(items, percent) {\n  return 0;\n}\n";
const DISCOUNT_DONE = [
  'import { total } from "../src/cart.mjs";',
  "export function discounted(items, percent) {",
  "  return (total(items) * (100 - percent)) / 100;",
  "}",
  "",
].join("\n");

/**
 * A suite runner like `pnpm -r test` over two packages: the root's `test/`
 * folder and the `pkg/` package. Like Vitest, it fails a package that has no
 * test files.
 */
const RUNNER = [
  'import { execFileSync } from "node:child_process";',
  'import { readdirSync } from "node:fs";',
  "let failed = false;",
  'for (const dir of ["test", "pkg"]) {',
  '  const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs"));',
  "  if (files.length === 0) {",
  "    console.log(`${dir} test: No test files found, exiting with code 1`);",
  "    console.log(`${dir} test: Failed`);",
  "    process.exit(1);",
  "  }",
  "  try {",
  '    const out = execFileSync("node", ["--test", ...files.map((f) => `${dir}/${f}`)], {',
  '      encoding: "utf8",',
  "    });",
  "    console.log(out);",
  "  } catch (error) {",
  "    console.log(error.stdout);",
  "    failed = true;",
  "  }",
  "}",
  "process.exit(failed ? 1 : 0);",
  "",
].join("\n");

/** Adds the runner, the discount stub, and its red test in the `pkg/` package. */
function addPackage(world: BuildWorld): void {
  const files: Record<string, string> = {
    "run-tests.mjs": RUNNER,
    "pkg/discount.mjs": DISCOUNT_STUB,
    "pkg/discount.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { discounted } from "./discount.mjs";',
      "assert.equal(discounted([{ price: 10 }, { price: 10 }], 10), 18);",
      "",
    ].join("\n"),
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(world.root, path)), { recursive: true });
    writeFileSync(join(world.root, path), content);
  }
  world.git(world.root, "add", "-A");
  world.git(world.root, "commit", "-q", "-m", "feat: add the discount package");
}

function plan(): BuildPlanInput {
  return cartPlan({
    title: "Cart total and discount",
    size: "medium",
    criteria: ["T1", "T2"].map((id) => ({ id: `AC-${id}`, text: `Task ${id} works.` })),
    tasks: [
      {
        id: "T1",
        title: "Cart total",
        description: "Implement the cart total.",
        ownedFiles: ["src/cart.mjs"],
        criteria: ["AC-T1"],
        tests: ["test/cart.test.mjs"],
      },
      {
        id: "T2",
        title: "Discount",
        description: "Implement the discount.",
        ownedFiles: ["pkg/discount.mjs"],
        criteria: ["AC-T2"],
        tests: ["pkg/discount.test.mjs"],
        dependsOn: ["T1"],
      },
    ],
    commands: {
      test: [{ command: "node run-tests.mjs" }],
      typecheck: [{ command: "node --check src/cart.mjs" }],
      lint: [{ command: "node lint.mjs" }],
    },
  });
}

const answer = (id: string, files: Record<string, string>, times = 1) => ({
  match: `Task ${id}`,
  times,
  output: { summary: `Did ${id}.`, criteria: [{ id: `AC-${id}`, met: true }] },
  writeFiles: files,
});

const gateOf = (world: BuildWorld, slug: string, n = 0) =>
  (world.jsonFiles(slug, "tasks/T1")[n] as { gate: TaskGateResult }).gate;

describe("a test run that the set-aside left without test files", () => {
  it("doesn't fail the task gate", async () => {
    const world = await buildWorld();
    addPackage(world);
    world.script({
      claude: [
        answer("T1", { "src/cart.mjs": CART_DONE }),
        answer("T2", { "pkg/discount.mjs": DISCOUNT_DONE }),
      ],
    });

    await world.start("empty", plan());
    const state = await world.settle("empty");

    expect(state.tasks.map((t) => [t.id, t.status, t.attempts])).toEqual([
      ["T1", "done", 1],
      ["T2", "done", 1],
    ]);
    const gate = gateOf(world, "empty");
    expect(gate.setAside).toEqual(["pkg/discount.test.mjs"]);
    expect(gate.commands[0]).toMatchObject({
      kind: "test",
      passed: true,
      exitCode: 1,
      excused: [expect.stringMatching(/no test files/i)],
    });
  });

  it("still fails the gate on a failing test in the same run", async () => {
    const world = await buildWorld();
    addPackage(world);
    world.script({ claude: [answer("T1", { "src/cart.mjs": CART_WRONG }, 4)] });

    await world.start("empty-wrong", plan());
    const state = await world.settle("empty-wrong");

    expect(state.tasks.find((t) => t.id === "T1")).toMatchObject({ status: "failed" });
    expect(gateOf(world, "empty-wrong").commands[0]).toMatchObject({
      kind: "test",
      passed: false,
    });
  });
});
