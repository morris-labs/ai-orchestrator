import { PolicyFileSchema } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../../src/core.js";
import {
  compareGate,
  extractFailures,
  formatRegressions,
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
});
