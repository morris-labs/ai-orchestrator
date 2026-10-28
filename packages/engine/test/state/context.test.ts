// RunContext: agent calls, leases, and persistence.
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import type { LeaseRequest, LeaseResponse, Vendor } from "@agentbox/contracts";
import {
  GrantingBroker,
  type AdapterRequest,
  type AdapterResult,
  type LeaseActual,
  type LeaseBroker,
  type ReviewOutput,
  type VendorAdapter,
} from "../../src/core.js";
import { EngineLeaseBroker } from "../../src/events/leases.js";
import { DecisionNeeded } from "../../src/state/context.js";
import { makeRun } from "./harness.js";

class LimitError extends Error {}

/** An adapter whose every call hits a usage limit. */
function limited(vendor: Vendor): VendorAdapter {
  const fail = () => Promise.reject(new LimitError("usage limit"));
  return {
    vendor,
    review: fail,
    continueReview: fail,
    verify: fail,
    fix: fail,
    confirm: fail,
    sweep: fail,
    detectLimit: (e: unknown) =>
      e instanceof LimitError ? { resetAt: null, message: "usage limit" } : null,
  } as unknown as VendorAdapter;
}

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

const review = (repoPath: string, extra: Record<string, unknown> = {}) => ({
  key: `k-${Math.random()}`,
  role: "disprover" as const,
  vendor: "codex" as const,
  method: "review" as const,
  request: { prompt: "p", repoPath, toolPolicy: "read-only" as const },
  groupId: null,
  estimateTokens: 1,
  allowFallback: true,
  ...extra,
});

/** A broker that redirects every grant to `to` under a lease id of its own. */
function redirecting(to: Vendor) {
  const settled: Array<{ leaseId: string; actual: LeaseActual }> = [];
  const broker: LeaseBroker = {
    acquire: (req: LeaseRequest): Promise<LeaseResponse> =>
      Promise.resolve({
        decision: "granted",
        leaseId: `server-${req.leaseId}`,
        vendor: to,
        redirectedFrom: req.vendor,
        expiresAt: "2099-01-01T00:00:00Z",
      }),
    settle: (leaseId, actual) => settled.push({ leaseId, actual }),
  };
  return { broker, settled };
}

describe("the cross-vendor rule under limits and redirects", () => {
  it("never falls back to the vendor the call must avoid", async () => {
    const { ctx, events } = await makeRun({
      adapters: {
        codex: limited("codex"),
        copilot: answering("copilot"),
        claude: answering("claude"),
      },
    });
    const out = await ctx.callAgent(review(ctx.state.request.repoPath, { avoid: ["copilot"] }));
    expect(out.vendor).toBe("claude");
    expect(events.ofType("agent.started").some((e) => e.vendor === "copilot")).toBe(false);
  });

  it("waits for the limit instead of using the avoided vendor when it is the only other one", async () => {
    const { ctx, events } = await makeRun({
      adapters: { codex: limited("codex"), copilot: answering("copilot") },
    });
    await expect(
      ctx.callAgent(review(ctx.state.request.repoPath, { avoid: ["copilot"] })),
    ).rejects.toThrow(/kept hitting its limit/);
    expect(events.ofType("agent.started").every((e) => e.vendor === "codex")).toBe(true);
  });

  it("asks a person when the server redirects the call to the avoided vendor", async () => {
    const { broker, settled } = redirecting("copilot");
    const { ctx } = await makeRun({
      adapters: { codex: answering("codex"), copilot: answering("copilot") },
      broker,
    });
    const call = ctx.callAgent(review(ctx.state.request.repoPath, { avoid: ["copilot"] }));
    await expect(call).rejects.toBeInstanceOf(DecisionNeeded);
    // The unused grant goes back under the server's lease id.
    expect(settled.map((s) => s.leaseId)).toEqual([`server-${ctx.state.id}-L1`]);
  });
});

describe("role.reassigned", () => {
  it("leaves a move the server made in a lease response to the server", async () => {
    const { broker } = redirecting("claude");
    const { ctx, events } = await makeRun({
      adapters: { codex: answering("codex"), claude: answering("claude") },
      broker,
    });
    const out = await ctx.callAgent(review(ctx.state.request.repoPath));
    expect(out.vendor).toBe("claude");
    expect(ctx.state.roles.disprover).toBe("claude");
    expect(events.ofType("role.reassigned")).toHaveLength(0);
  });

  it("announces a move the engine made on its own after a limit, once per change", async () => {
    const { ctx, events } = await makeRun({
      adapters: { codex: limited("codex"), copilot: answering("copilot") },
    });
    await ctx.callAgent(review(ctx.state.request.repoPath));
    // A second call that hits the same limit makes the same move again,
    // which changes nothing and gets no event.
    await ctx.callAgent(review(ctx.state.request.repoPath));
    const moves = events.ofType("role.reassigned");
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ role: "disprover", to: ["copilot"], reason: "limit" });
  });
});

describe("leases", () => {
  it("settles under the lease id the server answered with", async () => {
    const granting = new GrantingBroker();
    const settled: string[] = [];
    const broker: LeaseBroker = {
      acquire: async (req) => ({ ...(await granting.acquire(req)), leaseId: "L-reissued" }),
      settle: (leaseId) => settled.push(leaseId),
    };
    const { ctx, events } = await makeRun({ adapters: { codex: answering("codex") }, broker });
    await ctx.callAgent(review(ctx.state.request.repoPath));
    expect(settled).toEqual(["L-reissued"]);
    expect(events.ofType("lease.settled").map((e) => e.leaseId)).toEqual(["L-reissued"]);
    expect(events.ofType("agent.started")[0]?.leaseId).toBe("L-reissued");
  });

  it("lets a run waiting for a lease be cancelled", async () => {
    const log = { debug() {}, info() {}, warn() {}, error() {} };
    const broker = new EngineLeaseBroker({ log });
    try {
      const { run } = await makeRun({ adapters: { codex: answering("codex") }, broker });
      await run.start();
      for (let i = 0; i < 100 && broker.pendingIds().length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(broker.pendingIds().length).toBeGreaterThan(0);
      const state = await run.cancel();
      expect(state.status).toBe("cancelled");
      expect(broker.pendingIds()).toHaveLength(0);
    } finally {
      broker.close();
    }
  });
});
