// The failure fingerprint (#73): the failing checks of one gate run, each
// with its first error line, normalized so that two runs of the same failure
// compare equal.
import { describe, expect, it } from "vitest";
import { emptyBaseline, type TestBaseline } from "../../src/build/baseline.js";
import { failureFingerprint } from "../../src/build/fingerprint.js";
import type { TaskGateCommand, TaskGateResult } from "../../src/build/gate.js";
import { extractFailures } from "../../src/gate/gate.js";

const TEST = "node test/cart.test.mjs";

function command(output: string, extra: Partial<TaskGateCommand> = {}): TaskGateCommand {
  return {
    kind: "test",
    command: TEST,
    cwd: null,
    exitCode: 1,
    passed: false,
    timedOut: false,
    failures: extractFailures(output),
    outputTail: output,
    ...extra,
  };
}

function gate(...commands: TaskGateCommand[]): TaskGateResult {
  return {
    passed: commands.every((c) => c.passed),
    permission: { passed: true, writable: ["src/cart.mjs"], outside: [] },
    commands,
    leftovers: [],
  };
}

/** A Node.js assertion failure, printed from `dir` at `line`, at time `at`. */
function nodeFailure(dir: string, line: number, at: string, address: string): string {
  return [
    `file://${dir}/test/cart.test.mjs:${line}`,
    `[${at}] AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 2 !== 5 at ${dir}/test/cart.test.mjs:${line}:8 (handle ${address})`,
    `    at file://${dir}/test/cart.test.mjs:${line}:8`,
    "    at ModuleJob.run (node:internal/modules/esm/module_job:271:25)",
  ].join("\n");
}

describe("failureFingerprint", () => {
  it("is the same for failures that differ only in line numbers, paths, addresses, and timestamps", () => {
    const first = failureFingerprint(
      gate(command(nodeFailure("/tmp/aio-build-a1", 3, "2026-11-01T10:00:00.123Z", "0x7ffd1234"))),
    );
    const second = failureFingerprint(
      gate(command(nodeFailure("/srv/work/aio-build-b2", 17, "2026-11-02 23:59:01", "0xdeadbeef"))),
    );

    expect(first).toHaveLength(1);
    expect(first[0]).toContain(TEST);
    expect(first[0]).toContain("2 !== 5");
    expect(first[0]).not.toMatch(/aio-build|2026|0x7ffd|:3\b/);
    expect(second).toEqual(first);
  });

  it("strips the positions that TypeScript, Python, and Go print", () => {
    const typecheck = (out: string) =>
      failureFingerprint(gate(command(out, { kind: "typecheck", command: "tsc --noEmit" })));

    expect(typecheck("src/cart.ts(3,10): error TS2305: No exported member 'sum'.")).toEqual(
      typecheck("packages/shop/src/cart.ts(41,2): error TS2305: No exported member 'sum'."),
    );
    expect(failureFingerprint(gate(command('File "/srv/a/cart.py", line 12 Error')))).toEqual(
      failureFingerprint(gate(command('File "/home/b/cart.py", line 40 Error'))),
    );
    expect(failureFingerprint(gate(command("--- FAIL: cart_test.go:9: got 0, want 5")))).toEqual(
      failureFingerprint(gate(command("--- FAIL: cart_test.go:31: got 0, want 5"))),
    );
  });

  it("differs when the error itself differs", () => {
    const wrong = failureFingerprint(
      gate(command(nodeFailure("/tmp/a", 3, "2026-11-01T10:00:00Z", "0x1"))),
    );
    const other = failureFingerprint(
      gate(command("TypeError: items.reduce is not a function\n    at total (/tmp/a/src/cart.mjs:2:16)")),
    );

    expect(other).not.toEqual(wrong);
  });

  it("names each failing check, and leaves out the ones that passed", () => {
    const print = failureFingerprint({
      ...gate(
        command("not ok - totals the cart"),
        command("", { kind: "typecheck", command: "node --check src/cart.mjs", passed: true, exitCode: 0 }),
        command("src/cart.mjs: no console.log", { kind: "lint", command: "node lint.mjs" }),
      ),
      permission: { passed: false, writable: ["src/cart.mjs"], outside: ["README.md"] },
    });

    expect(print).toHaveLength(3);
    expect(print.join("\n")).toContain("node lint.mjs");
    expect(print.join("\n")).not.toContain("node --check");
    expect(print.join("\n")).toContain("permission");
  });

  it("uses the exit code or the timeout for a check with no error line", () => {
    expect(failureFingerprint(gate(command("", { exitCode: 3 })))).toEqual([
      `test \`${TEST}\`: exit 3`,
    ]);
    expect(failureFingerprint(gate(command("", { timedOut: true, exitCode: 143 })))).toEqual([
      `test \`${TEST}\`: timed out`,
    ]);
  });

  it("builds only from lines that the baseline doesn't excuse and the gate didn't quarantine", () => {
    const baseline: TestBaseline = {
      ...emptyBaseline(),
      knownFailing: [{ command: TEST, cwd: null, failures: ["not ok - an old failure"] }],
    };
    const alone = failureFingerprint(gate(command("not ok - totals the cart")), { baseline });
    const withKnown = failureFingerprint(
      gate(command("not ok - an old failure\nnot ok - totals the cart")),
      { baseline },
    );
    const withQuarantined = failureFingerprint(
      gate(
        command("not ok - a flaky one\nnot ok - totals the cart", {
          quarantined: ["not ok - a flaky one"],
        }),
      ),
      { baseline },
    );

    expect(alone).toEqual([`test \`${TEST}\`: not ok - totals the cart`]);
    expect(withKnown).toEqual(alone);
    expect(withQuarantined).toEqual(alone);
  });

  it("keeps a baseline line that names one of the task's own tests", () => {
    const baseline: TestBaseline = {
      ...emptyBaseline(),
      knownFailing: [{ command: TEST, cwd: null, failures: ["not ok - test/cart.test.mjs"] }],
    };
    const print = failureFingerprint(gate(command("not ok - test/cart.test.mjs")), {
      baseline,
      protect: ["test/cart.test.mjs"],
    });

    expect(print).toEqual([`test \`${TEST}\`: not ok - <path>`]);
  });

  it("is empty for a gate that passed", () => {
    expect(failureFingerprint(gate(command("", { passed: true, exitCode: 0 })))).toEqual([]);
  });
});
