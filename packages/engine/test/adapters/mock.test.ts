import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MockAdapter } from "../../src/adapters/mock.js";
import { VendorFindingsOutputSchema } from "../../src/adapters/output.js";
import { AdapterError, type CliRequest } from "../../src/adapters/types.js";
import { FIXTURES } from "./helpers.js";
import { join } from "node:path";

function req(prompt: string, extra: Omit<Partial<CliRequest<unknown>>, "outputSchema"> = {}) {
  return {
    prompt,
    cwd: "/w",
    tools: "read-only" as const,
    timeoutMs: 1000,
    outputSchema: VendorFindingsOutputSchema,
    ...extra,
  };
}

describe("MockAdapter", () => {
  it("replays a script file by method, match, and times", async () => {
    const mock = MockAdapter.fromFile(join(FIXTURES, "mock-script.json"));
    expect(mock.vendor).toBe("codex");
    const seen: unknown[] = [];
    const first = await mock.review({ ...req("Review group G-1"), onUsage: (s) => seen.push(s) });
    expect(first.output.findings[0]?.title).toBe("Missing await");
    expect(first.sessionId).toBe("thread-1");
    expect(first.tokens).toEqual({ input: 1000, output: 50 });
    expect(seen).toHaveLength(1);

    const again = await mock.review(req("Review group G-1"));
    expect(again.output.findings).toEqual([]);

    const more = await mock.continueReview({ ...req("more"), sessionId: "thread-1" });
    expect(more.sessionId).toBe("thread-1");
    expect(mock.calls.map((c) => c.role)).toEqual(["reviewer", "reviewer", "reviewer"]);
  });

  it("throws scripted limits that detectLimit reads", async () => {
    const mock = MockAdapter.fromFile(join(FIXTURES, "mock-script.json"));
    const err = await mock.verify(req("disprove")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(mock.detectLimit(err)).toMatchObject({
      kind: "usage_limit",
      resetAt: "2026-10-28T15:15:00Z",
    });
  });

  it("fails when no response matches", async () => {
    const mock = new MockAdapter({ vendor: "copilot", responses: [{ method: "fix", output: {} }] });
    await expect(mock.review(req("x"))).rejects.toThrow(/no response for review/);
    expect(mock.calls[0]?.responseIndex).toBe(-1);
  });

  it("validates the output against the request's schema", async () => {
    const mock = new MockAdapter({ vendor: "claude", responses: [{ output: { done: "yes" } }] });
    const err = (await mock
      .fix({ ...req("x"), outputSchema: z.object({ done: z.boolean() }) })
      .catch((e: unknown) => e)) as AdapterError;
    expect(err.kind).toBe("output");
  });

  it("honors delay, timeout, and cancellation", async () => {
    const mock = new MockAdapter({
      vendor: "claude",
      responses: [{ output: { findings: [] }, delayMs: 50 }],
    });
    await expect(mock.review(req("x"))).resolves.toMatchObject({ output: { findings: [] } });
    await expect(mock.review(req("x", { timeoutMs: 10 }))).rejects.toMatchObject({
      kind: "timeout",
    });
    const controller = new AbortController();
    const pending = mock.review(req("x", { signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "cancelled", vendor: "claude" });
  });

  it("reports scripted health and remaining responses", async () => {
    const mock = new MockAdapter({
      vendor: "codex",
      health: { available: false, version: null },
      responses: [{ times: 1 }],
    });
    expect(await mock.health()).toMatchObject({ available: false, error: expect.any(String) });
    expect(mock.remaining()).toBe(1);
  });

  it("rejects an invalid script", () => {
    expect(() => new MockAdapter({ vendor: "nope" as "codex", responses: [] })).toThrow();
  });
});
