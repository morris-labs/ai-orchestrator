// How the engine runs a per-test command: in the environment that the plan's
// test commands set with their leading NAME=value assignments.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gateFailureLine, runTaskGate } from "../../src/build/gate.js";
import { runRedCheck } from "../../src/build/red-check.js";
import {
  leadingAssignments,
  listedTestCommand,
  runListedTest,
  testEnvironmentNote,
} from "../../src/build/test-command.js";
import { BuildWorktree } from "../../src/build/worktree.js";
import { ExecaRunner, ShellRunner } from "../../src/range/exec.js";
import { buildSampleRepo } from "../state/scenario.js";

describe("leadingAssignments", () => {
  it.each([
    ["PATH=/usr/bin:$PATH corepack pnpm test", ["PATH=/usr/bin:$PATH"]],
    ["A=1 B='two words' C=\"x y\" D=a\\ b run", ["A=1", "B='two words'", 'C="x y"', "D=a\\ b"]],
    ["  A=1   run", ["A=1"]],
    ["corepack pnpm test", []],
    ["A=1", []],
    ["A=1; run", []],
    ["A=1 B=2; run", []],
    ["A=1 && run", []],
    ["A='open run", []],
    ["1A=2 run", []],
    ["env A=1 run", []],
  ])("reads %j as %j", (command, expected) => {
    expect(leadingAssignments(command)).toEqual(expected);
  });
});

describe("listedTestCommand", () => {
  const plan = {
    test: [
      { command: "PATH=/usr/bin:$PATH corepack pnpm -r test" },
      { command: "python3 -m unittest discover" },
      { command: "PATH=/opt/bin MODE=ci make test" },
    ],
  };

  it("runs a per-test command with the plan's test assignments in front", () => {
    expect(listedTestCommand("corepack pnpm exec vitest run a.test.ts", plan)).toEqual({
      command: "PATH=/usr/bin:$PATH MODE=ci corepack pnpm exec vitest run a.test.ts",
    });
  });

  it("keeps an assignment that the per-test command makes itself", () => {
    expect(listedTestCommand("MODE=dev PATH=/x vitest run", plan)).toEqual({
      command: "MODE=dev PATH=/x vitest run",
    });
  });

  it("runs a per-test command in the directory that every plan test command sets", () => {
    const sub = {
      test: [
        { command: "PATH=/usr/bin:$PATH pnpm test", cwd: "packages/server" },
        { command: "pnpm test:unit", cwd: "packages/server" },
      ],
    };
    expect(listedTestCommand("pnpm exec vitest run a.test.ts", sub)).toEqual({
      command: "PATH=/usr/bin:$PATH pnpm exec vitest run a.test.ts",
      cwd: "packages/server",
    });
  });

  it("runs a per-test command from the repository root when the plan test commands' directories differ", () => {
    const mixed = {
      test: [
        { command: "pnpm test", cwd: "packages/server" },
        { command: "python3 -m unittest", cwd: "packaging" },
      ],
    };
    expect(listedTestCommand("pnpm exec vitest run a.test.ts", mixed)).toEqual({
      command: "pnpm exec vitest run a.test.ts",
    });
    const partly = {
      test: [{ command: "pnpm test", cwd: "packages/server" }, { command: "make test" }],
    };
    expect(listedTestCommand("make check", partly)).toEqual({ command: "make check" });
  });

  it("leaves a command alone when the plan's test commands assign nothing", () => {
    expect(listedTestCommand("node a.test.mjs", { test: [{ command: "node t.mjs" }] })).toEqual({
      command: "node a.test.mjs",
    });
  });
});

describe("testEnvironmentNote", () => {
  it("tells the Test engineer which assignments go in front of its commands", () => {
    const note = testEnvironmentNote({ test: [{ command: "PATH=/usr/bin:$PATH pnpm test" }] });
    expect(note).toContain("with `PATH=/usr/bin:$PATH` in front");
  });

  it("names the directory that the engine runs the commands in", () => {
    const note = testEnvironmentNote({ test: [{ command: "pnpm test", cwd: "packages/server" }] });
    expect(note).toContain("in `packages/server`");
    expect(note).not.toContain("in front");
  });

  it("says nothing when the plan's test commands assign nothing", () => {
    expect(testEnvironmentNote({ test: [{ command: "pnpm test" }] })).toBe("");
  });
});

/** A test that fails on a load error unless the plan's environment is set, and on an assertion when it is. */
const ENV_TEST = [
  'import assert from "node:assert/strict";',
  'if (process.env.CART_ENV !== "gate") {',
  '  console.error("Error: the module was compiled against a different Node.js version using NODE_MODULE_VERSION 127");',
  "  process.exit(1);",
  "}",
  'assert.equal(process.env.CART_RESULT ?? "0", "5");',
  "",
].join("\n");

const PLAN = {
  test: [{ command: "CART_ENV=gate node test/env.test.mjs" }],
  typecheck: [],
  lint: [],
};

async function worktree(name: string): Promise<BuildWorktree> {
  const repo = buildSampleRepo();
  const tree = new BuildWorktree(
    new ExecaRunner(),
    repo,
    BuildWorktree.pathFor(repo, name),
    BuildWorktree.branchFor(name),
  );
  await tree.create(await tree.resolveBase(undefined));
  mkdirSync(join(tree.path, "test"), { recursive: true });
  writeFileSync(join(tree.path, "test/env.test.mjs"), ENV_TEST);
  return tree;
}

const LISTED = {
  file: "test/env.test.mjs",
  name: "AC1 totals the cart",
  criterion: "AC1",
  command: "node test/env.test.mjs",
};

describe("per-test commands in the plan's environment", () => {
  it("runs the red check's commands with the plan's test assignments", async () => {
    const tree = await worktree("red-env");

    const red = await runRedCheck({
      worktree: tree,
      tests: [LISTED],
      commands: PLAN,
      holds: new Set(),
      shell: new ShellRunner(new ExecaRunner()),
    });

    expect(red.tests.map((t) => [t.command, t.outcome])).toEqual([
      ["node test/env.test.mjs", "failed"],
    ]);
    expect(red.passed).toBe(true);
  });

  it("runs an earlier task's locked test in the task gate with the plan's test assignments", async () => {
    const tree = await worktree("gate-env");
    const base = await tree.resolveBase(undefined);

    const gate = await runTaskGate({
      worktree: tree,
      base,
      writable: ["**"],
      commands: {
        test: [{ command: "CART_ENV=gate CART_RESULT=5 true" }],
        typecheck: [],
        lint: [],
      },
      lock: {
        commit: base,
        redCheck: "x",
        files: [],
        tests: [LISTED],
        lockedAt: "2026-01-01T00:00:00Z",
      },
      earlier: [{ id: "T1", tests: ["test/env.test.mjs"] }],
      shell: new ShellRunner(new ExecaRunner()),
    });

    expect(gate.commands.map((c) => [c.command, c.passed])).toEqual([
      ["CART_ENV=gate CART_RESULT=5 true", true],
      ["CART_ENV=gate CART_RESULT=5 node test/env.test.mjs", true],
    ]);
    expect(gate.regressions).toBeUndefined();
  });
});

describe("runListedTest", () => {
  const shell = new ShellRunner(new ExecaRunner());

  it("fails a run that passes without running a test", async () => {
    const repo = buildSampleRepo();
    const run = await runListedTest(
      "echo ' Tests  3 skipped (3)'",
      { test: [{ command: "make test" }] },
      { repoPath: repo, shell },
    );

    expect(run).toMatchObject({ exitCode: 0, passed: false, noTests: true });
    expect(run.failures).toContain("the command ran no tests");
  });

  it("runs the command in the plan test commands' directory", async () => {
    const repo = buildSampleRepo();
    mkdirSync(join(repo, "sub"), { recursive: true });
    const run = await runListedTest(
      "test -e here.txt || touch here.txt",
      { test: [{ command: "make test", cwd: "sub" }] },
      { repoPath: repo, shell },
    );

    expect(run).toMatchObject({ passed: true, cwd: "sub" });
    expect(existsSync(join(repo, "sub/here.txt"))).toBe(true);
  });

  it("fails the task gate on an earlier task's locked test that runs no tests", async () => {
    const tree = await worktree("gate-empty");
    const base = await tree.resolveBase(undefined);
    const listed = { ...LISTED, command: "echo 'No tests found, exiting with code 0'" };

    const gate = await runTaskGate({
      worktree: tree,
      base,
      writable: ["**"],
      commands: { test: [{ command: "true" }], typecheck: [], lint: [] },
      lock: {
        commit: base,
        redCheck: "x",
        files: [],
        tests: [listed],
        lockedAt: "2026-01-01T00:00:00Z",
      },
      earlier: [{ id: "T1", tests: ["test/env.test.mjs"] }],
      shell,
    });

    expect(gate.passed).toBe(false);
    expect(gate.commands.map((c) => [c.command, c.passed])).toEqual([
      ["true", true],
      ["echo 'No tests found, exiting with code 0'", false],
    ]);
    expect(gateFailureLine(gate)).toContain("ran no tests");
  });
});
