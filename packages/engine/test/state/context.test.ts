// RunContext: agent calls, leases, and persistence.
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import type { AdapterRequest, AdapterResult, ReviewOutput, VendorAdapter } from "../../src/core.js";
import { makeRun } from "./harness.js";

function answering(vendor: "claude" | "codex" | "copilot"): VendorAdapter {
  const ok = (): Promise<AdapterResult<ReviewOutput>> =>
    Promise.resolve({
      output: { findings: [], ledger: [] },
      model: vendor,
      sessionId: null,
      tokens: { in: 1, out: 1 },
      usage: [],
      premiumRequests: 0,
      costEstimate: 0,
    });
  const fail = () => Promise.reject(new Error("unused"));
  return {
    vendor,
    review: (_r: AdapterRequest) => ok(),
    continueReview: ok,
    verify: fail,
    fix: fail,
    confirm: fail,
    sweep: fail,
    detectLimit: () => null,
  } as unknown as VendorAdapter;
}

describe("callAgent", () => {
  it("leaves no abort listener on the run's signal after a call", async () => {
    const { ctx } = await makeRun({ adapters: { codex: answering("codex") } });
    for (let i = 0; i < 15; i++) {
      await ctx.callAgent<ReviewOutput>({
        key: `k${i}`,
        role: "reviewer",
        vendor: "codex",
        method: "review",
        request: { prompt: "p", repoPath: ctx.state.request.repoPath, toolPolicy: "read-only" },
        groupId: null,
        estimateTokens: 1,
      });
    }
    expect(getEventListeners(ctx.signal, "abort")).toHaveLength(0);
  });
});

describe("the write chain", () => {
  it("recovers after one failed write and fails the run with a run.changed event", async () => {
    const { ctx, run, events } = await makeRun({ adapters: { codex: answering("codex") } });
    const store = ctx.store;
    const original = store.saveState.bind(store);
    let failing = true;
    store.saveState = (state) => {
      if (failing) {
        const error = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        return Promise.reject(error);
      }
      return original(state);
    };
    await expect(ctx.persist()).rejects.toThrow(/no space/);
    // The run driver hits the same failure, stops, and announces it.
    await run.start();
    const state = await run.settled();
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/no space/);
    const last = events.ofType("run.changed").at(-1);
    expect(last?.run.status).toBe("failed");
    // Once the disk recovers, the next write goes through.
    failing = false;
    await expect(ctx.persist()).resolves.toBeUndefined();
    expect((await store.loadState()).status).toBe("failed");
  });
});
