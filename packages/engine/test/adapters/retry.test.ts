import { describe, expect, it, vi } from "vitest";
import { isRetryable, retryOnce } from "../../src/adapters/retry.js";
import { AdapterError } from "../../src/adapters/types.js";

describe("retryOnce", () => {
  it("returns the first success without retrying", async () => {
    const call = vi.fn().mockResolvedValue(1);
    await expect(retryOnce(call)).resolves.toBe(1);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("retries a timeout once and returns the second result", async () => {
    const onRetry = vi.fn();
    const call = vi
      .fn()
      .mockRejectedValueOnce(new AdapterError("codex", "timeout", "slow"))
      .mockResolvedValueOnce(2);
    await expect(retryOnce(call, { onRetry })).resolves.toBe(2);
    expect(call).toHaveBeenNthCalledWith(2, 2);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("throws the second failure", async () => {
    const call = vi.fn().mockRejectedValue(new AdapterError("codex", "output", "bad"));
    await expect(retryOnce(call)).rejects.toThrow("bad");
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("doesn't retry a limit, sign-in, or cancellation", async () => {
    for (const kind of ["limit", "auth", "cancelled", "unavailable"] as const) {
      const call = vi.fn().mockRejectedValue(new AdapterError("claude", kind, kind));
      await expect(retryOnce(call)).rejects.toThrow(kind);
      expect(call).toHaveBeenCalledTimes(1);
    }
  });

  it("doesn't retry plain errors", () => {
    expect(isRetryable(new Error("x"))).toBe(false);
  });
});
