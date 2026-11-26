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

describe("the setup commands", () => {
  it("runs the setup commands before the other commands, with the test commands' assignments", async () => {
    const world = await buildWorld();
    commit(world, {
      ".gitignore": "deps/\n",
      "setup.mjs": [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'mkdirSync("deps", { recursive: true });',
        'writeFileSync("deps/env.txt", process.env.DEPS_ENV ?? "unset");',
        "",
      ].join("\n"),
      "test/deps.test.mjs": [
        'import { readFileSync } from "node:fs";',
        'if (readFileSync("deps/env.txt", "utf8") !== "plan") {',
        '  console.log("not ok - dependencies installed in the plan environment");',
        "  process.exit(1);",
        "}",
        'console.log("ok");',
        "",
      ].join("\n"),
    });
    world.script({ claude: DONE });
    const plan = withTest("DEPS_ENV=plan node test/deps.test.mjs");
    plan.commands = { ...plan.commands, setup: [{ command: "node setup.mjs" }] };

    await world.start("cart-total", plan);
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review" });
    const baseline = JSON.parse(world.file("cart-total", "baseline.json")) as SavedBaseline;
    expect(baseline.knownFailing.map((e) => e.command)).not.toContain(
      "DEPS_ENV=plan node test/deps.test.mjs",
    );
    const preflight = JSON.parse(world.file("cart-total", "preflight.json")) as {
      setup: { command: string; passed: boolean }[];
    };
    expect(preflight.setup).toEqual([
      expect.objectContaining({ command: "DEPS_ENV=plan node setup.mjs", passed: true }),
    ]);
    // The Developer hears that setup ran, and the command to rerun.
    const developer = world.calls().find((c) => c.prompt.includes("Task T1"));
    expect(developer?.prompt).toContain("`DEPS_ENV=plan node setup.mjs`");
  });

  it("stops the build when a setup command fails, with an escalation that holds its output", async () => {
    const world = await buildWorld();
    world.script({ claude: DONE });
    const plan = cartPlan();
    const setup = `node -e "console.error('gyp ERR! rebuild failed'); process.exit(1)"`;
    plan.commands = { ...plan.commands, setup: [{ command: setup }] };

    await world.start("cart-total", plan);
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ status: "waiting_escalation", step: "preflight" });
    expect(state.escalations).toEqual([
      expect.objectContaining({ kind: "preflight", taskId: null, level: "project_manager" }),
    ]);
    expect(state.escalations[0]?.summary).toContain("setup command");
    const [escalation] = world.jsonFiles("cart-total", "escalations") as Record<string, unknown>[];
    expect(escalation).toMatchObject({
      details: expect.stringContaining("gyp ERR! rebuild failed"),
    });
    expect(world.calls()).toHaveLength(0);
    expect(() => world.file("cart-total", "preflight.json")).toThrow();
  });

  it("warns the Project manager about a lockfile when the plan has no setup commands", async () => {
    const world = await buildWorld();
    commit(world, { "package-lock.json": "{}\n" });
    world.script({ claude: DONE });

    await world.start("cart-total");
    const state = await world.settle("cart-total");

    expect(state.step).not.toBe("preflight");
    const preflight = JSON.parse(world.file("cart-total", "preflight.json")) as {
      warnings: string[];
    };
    expect(preflight.warnings).toEqual([expect.stringContaining("package-lock.json")]);
    const inbox = await world.manager.inbox("cart-total", { all: true });
    expect(inbox.items).toContainEqual(
      expect.objectContaining({ kind: "digest", ref: "preflight-setup", file: "preflight.json" }),
    );
  });

  it("warns about nothing when the plan has no setup commands and the repository no lockfile", async () => {
    const world = await buildWorld();
    world.script({ claude: DONE });

    await world.start("cart-total");
    await world.settle("cart-total");

    const preflight = JSON.parse(world.file("cart-total", "preflight.json")) as Record<
      string,
      unknown
    >;
    expect(preflight.warnings).toBeUndefined();
  });
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

describe("the check baseline", () => {
  /** A lint script with one error that exists at the base, and one for a `console.log` in the cart. */
  const LEGACY_LINT = [
    'import { readFileSync } from "node:fs";',
    "let failed = false;",
    'console.error("src/legacy.mjs:3:1  error  Unexpected var, use let or const instead  no-var");',
    "failed = true;",
    'if (readFileSync("src/cart.mjs", "utf8").includes("console.log")) {',
    '  console.error("src/cart.mjs:2:3  error  Unexpected console statement  no-console");',
    "}",
    "process.exit(failed ? 1 : 0);",
    "",
  ].join("\n");

  it("records a lint failure that exists at the base, and the gate fails only on new lint lines", async () => {
    const world = await buildWorld();
    commit(world, { "legacy-lint.mjs": LEGACY_LINT });
    const noisy = `${CART_DONE}console.log("total");\n`;
    world.script({
      claude: [
        { match: "attempt 2 of", output: REPORT, writeFiles: { "src/cart.mjs": CART_DONE } },
        { match: "Task T1", output: REPORT, writeFiles: { "src/cart.mjs": noisy } },
      ],
    });
    const plan = cartPlan();
    plan.commands = { ...plan.commands, lint: [{ command: "node legacy-lint.mjs" }] };

    await world.start("cart-total", plan);
    const state = await world.settle("cart-total");

    expect(state).toMatchObject({ step: "review" });
    expect(state.tasks[0]).toMatchObject({ status: "done", attempts: 2 });
    const baseline = JSON.parse(world.file("cart-total", "baseline.json")) as {
      checks?: { kind: string; command: string; lines: string[] }[];
    };
    expect(baseline.checks).toEqual([
      expect.objectContaining({
        kind: "lint",
        command: "node legacy-lint.mjs",
        lines: [expect.stringContaining("Unexpected var")],
      }),
    ]);
    const [first, second] = world.jsonFiles("cart-total", "tasks/T1") as {
      gate: { passed: boolean; commands: { kind: string; passed: boolean; excused?: string[] }[] };
    }[];
    expect(first!.gate.passed).toBe(false);
    expect(first!.gate.commands.find((c) => c.kind === "lint")?.passed).toBe(false);
    expect(second!.gate.passed).toBe(true);
    expect(second!.gate.commands.find((c) => c.kind === "lint")).toMatchObject({
      passed: true,
      excused: [expect.stringContaining("Unexpected var")],
    });
  });
});
