// The bridge from CLI adapters to the core's VendorAdapter.
import { describe, expect, it } from "vitest";
import {
  BridgedAdapter,
  METHOD_SCHEMAS,
  toCliRequest,
  toCoreResult,
} from "../../src/adapters/bridge.js";
import { MockAdapter } from "../../src/adapters/mock.js";
import { AdapterError, type CliResult } from "../../src/adapters/types.js";
import { ReviewOutputSchema, VerifyOutputSchema } from "../../src/core.js";

const base = {
  prompt: "Review it",
  repoPath: "/repo",
  toolPolicy: "read-only" as const,
  timeoutMs: 1000,
};

describe("toCliRequest", () => {
  it("maps the fields and picks the method's schemas", () => {
    const req = toCliRequest("verify", {
      ...base,
      extraDirs: ["/base"],
      scratchDir: "/scratch",
      model: "opus",
    });
    expect(req).toMatchObject({
      prompt: "Review it",
      cwd: "/repo",
      tools: "read-only",
      addDirs: ["/base", "/scratch"],
      scratchDir: "/scratch",
      model: "opus",
      timeoutMs: 1000,
    });
    expect(req.outputSchema).toBe(VerifyOutputSchema);
    expect(req.jsonSchema).toBe(METHOD_SCHEMAS.verify.json);
    expect("sessionId" in req).toBe(false);
  });

  it("keeps the session for a continuation and leaves out empty fields", () => {
    const req = toCliRequest("continueReview", { ...base, sessionId: "s-1" });
    expect(req.sessionId).toBe("s-1");
    expect(req.outputSchema).toBe(ReviewOutputSchema);
    expect(req).not.toHaveProperty("addDirs");
    expect(req).not.toHaveProperty("model");
  });
});

describe("toCoreResult", () => {
  const result: CliResult<unknown> = {
    output: { findings: [] },
    sessionId: "s",
    model: null,
    usage: [
      {
        vendor: "copilot",
        account: "a",
        window: "month",
        utilization: 0.1,
        spendUsd: 3,
        ceiling: { kind: "spend", period: "month", maxUsd: 30 },
        resetAt: null,
        sampleSource: "billing_api",
      },
    ],
    tokens: { input: 10, output: 2 },
    premiumRequests: 1.5,
    aiCredits: 40,
    raw: "",
    durationMs: 5,
  };

  it("renames tokens, drops the ceiling, and passes AI credits through", () => {
    const out = toCoreResult("copilot", result, "auto");
    expect(out).toMatchObject({
      model: "auto",
      tokens: { in: 10, out: 2 },
      premiumRequests: 1.5,
      aiCredits: 40,
      costEstimate: 0,
    });
    expect(out.usage[0]).not.toHaveProperty("ceiling");
    expect(out.usage[0]).toMatchObject({ sampleSource: "billing_api" });
  });

  it("falls back to the vendor name for the model and uses the CLI's cost", () => {
    const { aiCredits: _a, ...rest } = result;
    const out = toCoreResult("codex", { ...rest, costUsd: 0.2 }, undefined);
    expect(out.model).toBe("codex");
    expect(out.costEstimate).toBe(0.2);
    expect(out).not.toHaveProperty("aiCredits");
  });
});

describe("BridgedAdapter", () => {
  it("calls the CLI adapter's method and parses the method's output", async () => {
    const mock = new MockAdapter({
      vendor: "codex",
      responses: [
        { method: "review", output: { findings: [] }, tokens: { input: 3, output: 4 } },
        { method: "continueReview", output: { findings: [] } },
      ],
    });
    const bridged = new BridgedAdapter(mock);
    const out = await bridged.review(base);
    expect(out.output).toEqual({ findings: [], ledger: [] });
    expect(out.tokens).toEqual({ in: 3, out: 4 });
    await bridged.continueReview({ ...base, sessionId: "thread-1" });
    expect(mock.calls[1]).toMatchObject({ method: "continueReview" });
    expect(mock.calls[1]?.request.sessionId).toBe("thread-1");
  });

  it("retries only retryable adapter errors and reads limits from the CLI adapter", () => {
    const bridged = new BridgedAdapter(new MockAdapter({ vendor: "claude", responses: [] }));
    expect(bridged.isRetryable(new AdapterError("claude", "output", "bad json"))).toBe(true);
    expect(bridged.isRetryable(new AdapterError("claude", "auth", "not logged in"))).toBe(false);
    expect(bridged.isRetryable(new Error("core timeout"))).toBe(true);
    const limit = { kind: "usage_limit" as const, resetAt: null, message: "limit" };
    expect(bridged.detectLimit(new AdapterError("claude", "limit", "x", { limit }))).toBe(limit);
  });
});
