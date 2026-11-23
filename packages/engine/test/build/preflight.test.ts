// Preflight and the test baseline (#70): the engine checks that the build
// plan's commands run, records the known failing and flaky tests from three
// test runs, and the task gate doesn't fail an attempt for them.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CART_DONE, CART_WRONG, REPORT, buildWorld, cartPlan, type BuildWorld } from "./harness.js";
import { tempDir } from "../tmp.js";

/** Commits `files` to the sample project's `main`, where the build starts. */
function commit(world: BuildWorld, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files))
    writeFileSync(join(world.root, path), content);
  world.git(world.root, "add", "-A");
  world.git(world.root, "commit", "-q", "-m", "test: add tests");
}

/** A test file that always fails on `name`. */
function failingTest(name: string): string {
  return `console.log("not ok - ${name}");\nprocess.exit(1);\n`;
}

/**
 * A test file that fails on `name` in the runs that `failOn` lists (1 is
 * the first run), counting runs in a file outside the repository.
 */
function flakyTest(name: string, failOn: number[]): string {
  const counter = join(tempDir("aio-flaky-"), "runs");
  return [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    `const file = ${JSON.stringify(counter)};`,
    'const run = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1;',
    "writeFileSync(file, String(run));",
    `if (${JSON.stringify(failOn)}.includes(run)) {`,
    `  console.log("not ok - ${name}");`,
    "  process.exit(1);",
    "}",
    'console.log("ok");',
    "",
  ].join("\n");
}

interface SavedBaseline {
  knownFailing: { command: string; failures: string[] }[];
  flaky: { command: string; failure: string; source: Record<string, unknown> }[];
}

function withTest(command: string) {
  const plan = cartPlan();
  plan.commands = { ...plan.commands, test: [...plan.commands.test, { command }] };
  return plan;
}

const DONE = [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } }];

describe("preflight", () => {
  it.each([
    ["test", { test: [{ command: "node test/cart.test.mjs" }, { command: "no-such-runner" }] }],
    ["typecheck", { typecheck: [{ command: "no-such-checker --strict" }] }],
    ["lint", { lint: [{ command: "node lint.mjs", cwd: "missing-dir" }] }],
  ])(
    "stops a plan whose %s command can't run with an escalation that names it",
    async (_kind, commands) => {
      const world = await buildWorld();
      world.script({ claude: [{ match: "Task T1", output: REPORT }] });
      const plan = cartPlan();
      plan.commands = { ...plan.commands, ...commands };
      const named = Object.values(commands)[0]?.at(-1)?.command ?? "";

      await world.start("cart-total", plan);
      const state = await world.settle("cart-total");

      expect(state).toMatchObject({ status: "waiting_escalation", step: "preflight" });
      expect(state.escalations).toEqual([
        expect.objectContaining({ kind: "preflight", taskId: null, level: "project_manager" }),
      ]);
      expect(state.escalations[0]?.summary).toContain(named);
      const [escalation] = world.jsonFiles("cart-total", "escalations") as Record<
        string,
        unknown
      >[];
      expect(escalation).toMatchObject({
        step: "preflight",
        details: expect.stringContaining(named),
      });
      expect(world.calls()).toHaveLength(0);
      expect(state.tasks[0]).toMatchObject({ status: "pending", attempts: 0 });
    },
  );
});

describe("the test baseline", () => {
  it("records a known failing test, and the task gate doesn't fail the attempt for it", async () => {
    const world = await buildWorld();
    commit(world, { "test/legacy.test.mjs": failingTest("legacy discount rounding") });
    world.script({ claude: DONE });

    await world.start("cart-total", withTest("node test/legacy.test.mjs"));
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review" });
    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 1 });
    const baseline = JSON.parse(world.file("cart-total", "baseline.json")) as SavedBaseline;
    expect(baseline.knownFailing).toContainEqual(
      expect.objectContaining({
        command: "node test/legacy.test.mjs",
        failures: ["not ok - legacy discount rounding"],
      }),
    );
    expect(baseline.flaky).toEqual([]);
  });

  it("quarantines a test whose result differs between the preflight runs", async () => {
    const world = await buildWorld();
    // Fails in the second preflight run only, and again in the task gate's
    // first run, where the baseline excuses it without a rerun.
    commit(world, { "test/stock.test.mjs": flakyTest("stock sync", [2, 4]) });
    world.script({ claude: DONE });

    await world.start("cart-total", withTest("node test/stock.test.mjs"));
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review" });
    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 1 });
    const baseline = JSON.parse(world.file("cart-total", "baseline.json")) as SavedBaseline;
    expect(baseline.flaky).toEqual([
      {
        command: "node test/stock.test.mjs",
        cwd: null,
        failure: "not ok - stock sync",
        source: { at: "preflight" },
      },
    ]);
    expect(baseline.knownFailing.map((e) => e.command)).not.toContain("node test/stock.test.mjs");
    const [attempt] = world.jsonFiles("cart-total", "tasks/T1") as {
      gate: { commands: { command: string; passed: boolean; excused?: string[] }[] };
    }[];
    expect(attempt?.gate.commands).toContainEqual(
      expect.objectContaining({
        command: "node test/stock.test.mjs",
        passed: true,
        excused: ["not ok - stock sync"],
      }),
    );
  });

  it("quarantines a test that fails in the task gate and passes in its rerun, and passes the attempt", async () => {
    const world = await buildWorld();
    // Passes the three preflight runs, fails the gate's first run, and
    // passes the rerun.
    commit(world, { "test/stock.test.mjs": flakyTest("stock sync", [4]) });
    world.script({ claude: DONE });

    await world.start("cart-total", withTest("node test/stock.test.mjs"));
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review" });
    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 1 });
    expect(world.calls()).toHaveLength(1);
    const baseline = JSON.parse(world.file("cart-total", "baseline.json")) as SavedBaseline;
    expect(baseline.flaky).toEqual([
      {
        command: "node test/stock.test.mjs",
        cwd: null,
        failure: "not ok - stock sync",
        source: { at: "gate", taskId: "T1", attempt: 1 },
      },
    ]);
    const [attempt] = world.jsonFiles("cart-total", "tasks/T1") as {
      gate: {
        passed: boolean;
        quarantined?: unknown[];
        commands: { command: string; passed: boolean; firstRun?: { passed: boolean } }[];
      };
    }[];
    expect(attempt?.gate.passed).toBe(true);
    expect(attempt?.gate.quarantined).toHaveLength(1);
    expect(attempt?.gate.commands).toContainEqual(
      expect.objectContaining({
        command: "node test/stock.test.mjs",
        passed: true,
        firstRun: expect.objectContaining({ passed: false }),
      }),
    );
  });

  it("fails an attempt on the task's own test even when it failed at preflight", async () => {
    const world = await buildWorld();
    world.script({
      claude: [{ match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": CART_WRONG } }],
    });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    const baseline = JSON.parse(world.file("cart-total", "baseline.json")) as SavedBaseline;
    expect(baseline.knownFailing.map((e) => e.command)).toEqual(["node test/cart.test.mjs"]);
    expect(state).toMatchObject({ status: "waiting_escalation", step: "tasks" });
    expect(state.escalations).toEqual([expect.objectContaining({ kind: "attempt_cap" })]);
  });
});
