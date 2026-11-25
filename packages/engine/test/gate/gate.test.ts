import { PolicyFileSchema } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../../src/core.js";
import {
  compareGate,
  diagnosticLines,
  extractFailures,
  formatRegressions,
  keptOutput,
  runGate,
  type GateRun,
} from "../../src/gate/gate.js";

function run(
  ...commands: Array<{ command: string; passed: boolean; failures?: string[] }>
): GateRun {
  return {
    passed: commands.every((c) => c.passed),
    commands: commands.map((c) => ({
      kind: "test",
      command: c.command,
      cwd: null,
      exitCode: c.passed ? 0 : 1,
      passed: c.passed,
      timedOut: false,
      failures: c.failures ?? [],
      outputTail: "tail",
    })),
  };
}

describe("gate", () => {
  it("extracts failure lines without timings or colors", () => {
    const out =
      "\u001b[31mFAIL\u001b[0m src/a.test.ts (12 ms)\nok 1\nFAIL src/a.test.ts (40 ms)\nError: boom at 0x7ffd\n";
    expect(extractFailures(out)).toEqual(["Error: boom at 0x", "FAIL src/a.test.ts"]);
  });

  it("doesn't count fewer failures than the baseline as a regression", () => {
    const vitest = (failing: string[], passed: number) =>
      [
        ...failing.map((name) => ` FAIL  test/${name}.test.ts > ${name}`),
        ` Test Files  ${failing.length} failed | 3 passed (${failing.length + 3})`,
        `      Tests  ${failing.length} failed | ${passed} passed (${failing.length + passed})`,
      ].join("\n");
    const jest = (failing: string[], passed: number) =>
      [
        ...failing.map((name) => `FAIL test/${name}.test.js`),
        `Test Suites: ${failing.length} failed, 3 passed, ${failing.length + 3} total`,
        `Tests:       ${failing.length} failed, ${passed} passed, ${failing.length + passed} total`,
      ].join("\n");
    for (const output of [vitest, jest]) {
      const baseline = run({
        command: "test",
        passed: false,
        failures: extractFailures(output(["a", "b"], 40)),
      });
      const better = run({
        command: "test",
        passed: false,
        failures: extractFailures(output(["a"], 41)),
      });
      expect(compareGate(baseline, better).regressed).toBe(false);
      const worse = compareGate(
        baseline,
        run({ command: "test", passed: false, failures: extractFailures(output(["a", "c"], 40)) }),
      );
      expect(worse.regressed).toBe(true);
      expect(worse.regressions[0]?.newFailures).toHaveLength(1);
      expect(worse.regressions[0]?.newFailures[0]).toContain("c.test");
    }
  });

  it("flags a passing command that fails, and new failures in a failing one", () => {
    const baseline = run(
      { command: "test", passed: true },
      { command: "lint", passed: false, failures: ["E1"] },
    );
    expect(
      compareGate(
        baseline,
        run(
          { command: "test", passed: true },
          { command: "lint", passed: false, failures: ["E1"] },
        ),
      ).regressed,
    ).toBe(false);
    const worse = compareGate(
      baseline,
      run(
        { command: "test", passed: false, failures: ["T1"] },
        { command: "lint", passed: false, failures: ["E1", "E2"] },
      ),
    );
    expect(worse.regressions.map((r) => [r.command, r.newFailures])).toEqual([
      ["test", ["T1"]],
      ["lint", ["E2"]],
    ]);
    expect(formatRegressions(worse)).toContain("Command: lint");
  });

  it("doesn't count a test command that fails only on excused lines, and counts any other line", () => {
    const baseline = run({ command: "test", passed: true });
    const excused = [{ command: "test", cwd: null, failures: ["not ok - stock sync"] }];

    const flaky = run({ command: "test", passed: false, failures: ["not ok - stock sync"] });
    expect(compareGate(baseline, flaky, excused).regressed).toBe(false);

    const both = run({
      command: "test",
      passed: false,
      failures: ["not ok - stock sync", "not ok - cart total"],
    });
    expect(compareGate(baseline, both, excused).regressed).toBe(true);
    // Without the excused lines, the flaky failure is a regression too.
    expect(compareGate(baseline, flaky).regressed).toBe(true);
  });

  it("runs test and lint commands in the repository", async () => {
    const seen: Array<{ line: string; cwd: string }> = [];
    const shell: CommandRunner = {
      run: async (line, _args, options) => {
        seen.push({ line, cwd: options.cwd });
        return {
          exitCode: line.includes("lint") ? 2 : 0,
          stdout: "ERROR x\n",
          stderr: "",
          timedOut: false,
        };
      },
    };
    const policy = PolicyFileSchema.parse({
      version: 1,
      tests: [{ command: "npm test", cwd: "web" }],
      lint: [{ command: "npm run lint" }],
    });
    const result = await runGate(policy, { repoPath: "/repo", shell });
    expect(seen).toEqual([
      { line: "npm test", cwd: "/repo/web" },
      { line: "npm run lint", cwd: "/repo" },
    ]);
    expect(result.passed).toBe(false);
    expect(result.commands.map((c) => [c.kind, c.passed])).toEqual([
      ["test", true],
      ["lint", false],
    ]);
  });

  it("runs the policy's type check commands between its tests and lint", async () => {
    const seen: string[] = [];
    const shell: CommandRunner = {
      run: async (line) => {
        seen.push(line);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
    };
    const policy = PolicyFileSchema.parse({
      version: 1,
      tests: [{ command: "npm test" }],
      typecheck: [{ command: "npx tsc --noEmit" }],
      lint: [{ command: "npm run lint" }],
    });
    const result = await runGate(policy, { repoPath: "/repo", shell });
    expect(seen).toEqual(["npm test", "npx tsc --noEmit", "npm run lint"]);
    expect(result.commands.map((c) => c.kind)).toEqual(["test", "typecheck", "lint"]);
  });

  it("runs commands without Python bytecode and lists the untracked files they made", async () => {
    const { execFileSync } = await import("node:child_process");
    const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tempDir } = await import("../tmp.js");
    const { ExecaRunner, ShellRunner } = await import("../../src/range/exec.js");
    const repo = tempDir("gate-clean-");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, ".gitignore"), "ignored/\n");
    writeFileSync(join(repo, "mine.txt"), "untracked before the gate");
    const policy = PolicyFileSchema.parse({
      version: 1,
      tests: [
        {
          command:
            'echo "$PYTHONDONTWRITEBYTECODE" > flag.out; mkdir -p cache ignored .aio; touch cache/a.pyc ignored/keep .aio/run.json',
        },
      ],
    });
    mkdirSync(join(repo, "sub"));
    const result = await runGate(policy, {
      repoPath: repo,
      shell: new ShellRunner(),
      git: new ExecaRunner(),
    });
    expect(result.passed).toBe(true);
    // The gate deletes nothing: it can't tell its own files from a person's.
    expect(readFileSync(join(repo, "flag.out"), "utf8")).toBe("1\n");
    expect(existsSync(join(repo, "cache", "a.pyc"))).toBe(true);
    expect(result.leftovers).toEqual(["cache/a.pyc", "flag.out"]);
    expect(existsSync(join(repo, "mine.txt"))).toBe(true);
    expect(existsSync(join(repo, "ignored", "keep"))).toBe(true);
    expect(existsSync(join(repo, ".aio", "run.json"))).toBe(true);
    expect(result.commands[0]?.outputTail).toBe("");
  });

  it("keeps a file that someone else creates in the checkout while the gate runs", async () => {
    const { execFileSync } = await import("node:child_process");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tempDir } = await import("../tmp.js");
    const { ExecaRunner, ShellRunner } = await import("../../src/range/exec.js");
    const repo = tempDir("gate-person-");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const policy = PolicyFileSchema.parse({ version: 1, tests: [{ command: "sleep 1" }] });
    // A person saves new work 300 ms into the gate's test command.
    const timer = setTimeout(
      () => writeFileSync(join(repo, "SYNTHETIC_notes.py"), "print('mine')\n"),
      300,
    );
    try {
      const result = await runGate(policy, {
        repoPath: repo,
        shell: new ShellRunner(),
        git: new ExecaRunner(),
      });
      expect(result.leftovers).toEqual(["SYNTHETIC_notes.py"]);
    } finally {
      clearTimeout(timer);
    }
    expect(readFileSync(join(repo, "SYNTHETIC_notes.py"), "utf8")).toBe("print('mine')\n");
  });

  it("passes PYTHONDONTWRITEBYTECODE to every command", async () => {
    const envs: Array<Record<string, string> | undefined> = [];
    const shell: CommandRunner = {
      run: async (_line, _args, options) => {
        envs.push(options.env);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      },
    };
    const policy = PolicyFileSchema.parse({
      version: 1,
      tests: [{ command: "t" }],
      lint: [{ command: "l" }],
    });
    await runGate(policy, { repoPath: "/repo", shell });
    expect(envs).toEqual([{ PYTHONDONTWRITEBYTECODE: "1" }, { PYTHONDONTWRITEBYTECODE: "1" }]);
  });
});

describe("diagnosticLines", () => {
  it("keeps every lint and type check line, without positions or count lines", () => {
    const before = [
      "src/a.ts(10,5): error TS2322: Type 'number' is not assignable to type 'string'.",
      "  3:1  error  Unexpected var  no-var",
      "Found 2 errors in 1 file.",
      "",
    ].join("\n");
    const after = [
      "src/a.ts(14,5): error TS2322: Type 'number' is not assignable to type 'string'.",
      "  7:1  error  Unexpected var  no-var",
      "Found 3 errors in 2 files.",
    ].join("\n");

    expect(diagnosticLines(before)).toEqual([
      "L:C error Unexpected var no-var",
      "src/a.ts(L,C): error TS2322: Type 'number' is not assignable to type 'string'.",
    ]);
    expect(diagnosticLines(after)).toEqual(diagnosticLines(before));
  });
});

describe("keptOutput", () => {
  it("keeps short output whole, without colors", () => {
    expect(keptOutput("\u001b[31mAssertionError\u001b[0m: expected 1 to be 2")).toBe(
      "AssertionError: expected 1 to be 2",
    );
  });

  it("keeps the start and the end of output longer than the limit", () => {
    const output = `AssertionError: head\n${"x".repeat(1000)}\nTests  1 failed`;
    const kept = keptOutput(output, 100);
    expect(kept.startsWith("AssertionError: head")).toBe(true);
    expect(kept.endsWith("Tests  1 failed")).toBe(true);
    expect(kept).toContain("[... output cut ...]");
    expect(kept.length).toBeLessThan(150);
  });
});
