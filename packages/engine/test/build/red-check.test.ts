// How the red check reads a test command's result.
import { describe, expect, it } from "vitest";
import { classifyRun, ranNoTests } from "../../src/build/red-check.js";

describe("classifyRun", () => {
  it.each([
    [
      "a Node.js assertion",
      "failed",
      "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n0 !== 5",
    ],
    ["a Vitest expectation", "failed", "AssertionError: expected 0 to be 5 // Object.is equality"],
    ["a Python assertion", "failed", "    assert total([2, 3]) == 5\nAssertionError"],
    [
      "a Go test failure",
      "failed",
      "--- FAIL: TestTotal (0.00s)\n    cart_test.go:9: got 0, want 5",
    ],
    [
      "a missing export",
      "error",
      "SyntaxError: The requested module '../src/cart.mjs' does not provide an export named 'sum'",
    ],
    [
      "a missing module",
      "error",
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/repo/src/missing.mjs'",
    ],
    ["a Python import error", "error", "ModuleNotFoundError: No module named 'cart'"],
    ["a Go build failure", "error", "FAIL\texample.com/shop [build failed]"],
    [
      "a TypeScript error",
      "error",
      "src/cart.test.ts(3,10): error TS2305: Module has no exported member 'sum'.",
    ],
    ["an undefined name", "error", "ReferenceError: total is not defined"],
    ["a crash with no assertion", "error", "Error: connect ECONNREFUSED 127.0.0.1:5432"],
    [
      "a native module built for another Node.js",
      "error",
      "Error: The module 'better_sqlite3.node' was compiled against a different Node.js version using\nNODE_MODULE_VERSION 127. This version of Node.js requires\nNODE_MODULE_VERSION 147.\nAssertionError: expected undefined to be 5",
    ],
    ["a module that fails to load", "error", "Error: dlopen failed [ERR_DLOPEN_FAILED]"],
    [
      "a Vitest file that fails to collect",
      "error",
      "⎯⎯ Failed Suites 1 ⎯⎯\n FAIL test/cart.test.ts [ test/cart.test.ts ]\nError: boom",
    ],
    [
      "a Jest suite that fails to run",
      "error",
      "FAIL test/cart.test.js\n  ● Test suite failed to run",
    ],
    [
      "a pytest collection error",
      "error",
      "ERROR collecting test_cart.py\n1 error during collection",
    ],
    ["a missing test file", "error", "No test files found, exiting with code 1"],
  ])("reads %s as %s", (_label, outcome, output) => {
    expect(classifyRun({ exitCode: 1, timedOut: false, output }).outcome).toBe(outcome);
  });

  it.each([
    ["Vitest, every test filtered out", " Test Files  1 skipped (1)\n      Tests  17 skipped (17)"],
    ["Vitest, no tests in the file", " Test Files  1 passed (1)\n      Tests  no tests"],
    ["Jest", "No tests found, exiting with code 0"],
    ["pytest", "collected 4 items / 4 deselected\n==== 4 deselected in 0.01s ===="],
    ["pytest, nothing collected", "==== no tests ran in 0.01s ===="],
    ["Go", "testing: warning: no tests to run\nPASS\nok  example.com/shop 0.01s [no tests to run]"],
    ["Mocha", "  0 passing (2ms)"],
    ["the Node.js test runner", "# tests 0\n# pass 0\n# fail 0"],
  ])("reads a run that ran no tests (%s) as an error, whatever its exit code", (_label, output) => {
    for (const exitCode of [0, 1, 5]) {
      expect(classifyRun({ exitCode, timedOut: false, output })).toEqual({
        outcome: "error",
        reason: "the test command ran no tests",
      });
    }
    expect(ranNoTests(output)).toBe(true);
  });

  it("doesn't read a run with tests that ran as one that ran none", () => {
    expect(ranNoTests(" Tests  1 passed | 69 skipped (70)")).toBe(false);
    expect(ranNoTests("# tests 3\n# pass 3")).toBe(false);
    expect(ranNoTests("  10 passing (2ms)")).toBe(false);
    expect(
      ranNoTests("  0 passing (2ms)\n  1 failing\n  AssertionError: expected 0 to equal 5"),
    ).toBe(false);
    expect(ranNoTests("==== 1 passed, 3 deselected in 0.01s ====")).toBe(false);
  });

  it("reads exit code 0 as passed and a timeout as an error", () => {
    expect(classifyRun({ exitCode: 0, timedOut: false, output: "ok" }).outcome).toBe("passed");
    expect(classifyRun({ exitCode: null, timedOut: true, output: "" })).toEqual({
      outcome: "error",
      reason: "the test command timed out",
    });
  });
});
