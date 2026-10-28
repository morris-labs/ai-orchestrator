import { describe, expect, it } from "vitest";
import { isRetryable } from "../../src/adapters/retry.js";
import { AdapterError } from "../../src/adapters/types.js";

describe("isRetryable", () => {
  it("retries a timeout, an unusable answer, and a process failure", () => {
    for (const kind of ["timeout", "output", "process"] as const) {
      expect(isRetryable(new AdapterError("codex", kind, kind))).toBe(true);
    }
  });

  it("doesn't retry a limit, sign-in, cancellation, or a missing CLI", () => {
    for (const kind of ["limit", "auth", "cancelled", "unavailable"] as const) {
      expect(isRetryable(new AdapterError("claude", kind, kind))).toBe(false);
    }
  });

  it("doesn't retry plain errors", () => {
    expect(isRetryable(new Error("x"))).toBe(false);
  });
});
