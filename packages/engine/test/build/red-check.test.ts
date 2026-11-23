// How the red check reads a test command's result.
import { describe, expect, it } from "vitest";
import { classifyRun } from "../../src/build/red-check.js";

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
  ])("reads %s as %s", (_label, outcome, output) => {
    expect(classifyRun({ exitCode: 1, timedOut: false, output }).outcome).toBe(outcome);
  });

  it("reads exit code 0 as passed and a timeout as an error", () => {
    expect(classifyRun({ exitCode: 0, timedOut: false, output: "ok" }).outcome).toBe("passed");
    expect(classifyRun({ exitCode: null, timedOut: true, output: "" })).toEqual({
      outcome: "error",
      reason: "the test command timed out",
    });
  });
});
