// RunContext: agent calls, leases, and persistence.
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import type { LeaseRequest, LeaseResponse, Vendor } from "@aio/contracts";
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
import { DecisionNeeded, describeError } from "../../src/state/context.js";
import { disposeCheckouts, readOnlyRepo } from "../../src/state/steps.js";
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

describe("a failed agent call", () => {
  it("logs the reason at warn level before it retries", async () => {
    const warnings: Array<{ msg: string; fields: Record<string, unknown> | undefined }> = [];
    const log = {
      debug() {},
      info() {},
      warn: (msg: string, fields?: Record<string, unknown>) => warnings.push({ msg, fields }),
      error() {},
    };
    let calls = 0;
    const adapter = answering("codex");
    const ok = adapter.review.bind(adapter);
    adapter.review = (req: AdapterRequest) => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("claude exited 1:\n  lock held"))
        : (ok(req) as never);
    };
    const { ctx } = await makeRun({ adapters: { codex: adapter }, deps: { log } });
    const out = await ctx.callAgent<ReviewOutput>({
      key: "k1",
      role: "reviewer",
      vendor: "codex",
      method: "review",
      request: { prompt: "p", repoPath: ctx.state.request.repoPath, toolPolicy: "read-only" },
      groupId: "G01",
      estimateTokens: 1,
    });
    expect(out.output).toEqual({ findings: [], ledger: [] });
    expect(warnings).toEqual([
      {
        msg: "An agent call failed",
        fields: expect.objectContaining({
          key: "k1",
          vendor: "codex",
          role: "reviewer",
          outcome: "error",
          error: "claude exited 1: lock held",
        }),
      },
    ]);
  });
});

describe("describeError", () => {
  it("puts the message on one line and caps its length", () => {
    expect(describeError(new Error("a\n  b"))).toBe("a b");
    expect(describeError("plain")).toBe("plain");
    const long = describeError(new Error("x".repeat(600)));
    expect(long).toHaveLength(500);
    expect(long.endsWith("...")).toBe(true);
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

describe("a server redirect to a vendor the engine can't call", () => {
  it("hands the grant back and asks a person instead of calling either vendor", async () => {
    const { broker, settled } = redirecting("copilot");
    let codexCalls = 0;
    const codex = {
      ...answering("codex"),
      review: (r: AdapterRequest) => {
        codexCalls += 1;
        return answering("codex").review(r);
      },
    } as VendorAdapter;
    const { ctx, events } = await makeRun({ adapters: { codex }, broker });
    const err = await ctx.callAgent(review(ctx.state.request.repoPath)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecisionNeeded);
    expect((err as Error).message).toMatch(/no working copilot CLI/);
    expect(codexCalls).toBe(0);
    expect(events.ofType("agent.started")).toHaveLength(0);
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

  it("saves the lease counter before it asks, so a restart never reuses a lease id", async () => {
    const asked: string[] = [];
    const broker: LeaseBroker = {
      acquire: async (req) => {
        asked.push(req.leaseId);
        // The engine stops while the request is out.
        throw new Error("SYNTHETIC engine stop");
      },
      settle: () => undefined,
    };
    const { ctx } = await makeRun({ adapters: { codex: answering("codex") }, broker });
    await expect(ctx.acquireLease("codex", "reviewer", 1)).rejects.toThrow("SYNTHETIC");
    expect(asked).toEqual([`${ctx.state.id}-L1`]);
    expect((await ctx.store.loadEngineState()).counters.lease).toBe(1);
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

describe("a read-only call", () => {
  it("runs in the engine's checkout, fails when it changes it, and restores only that", async () => {
    const { writeFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    let calls = 0;
    const editing = {
      ...answering("codex"),
      review: (r: AdapterRequest) => {
        calls += 1;
        writeFileSync(join(r.repoPath, `stray-${calls}.txt`), "x");
        return answering("codex").review(r);
      },
    } as VendorAdapter;
    const { ctx, repo } = await makeRun({ adapters: { codex: editing } });
    const checkout = await readOnlyRepo(ctx);
    expect(checkout).not.toBe(repo);
    const call = ctx.callAgent<ReviewOutput>({
      key: "k",
      role: "reviewer",
      vendor: "codex",
      method: "review",
      request: { prompt: "p", repoPath: checkout, toolPolicy: "read-only" },
      groupId: null,
      estimateTokens: 1,
    });
    await expect(call).rejects.toThrow(/read-only call changed the worktree/);
    expect(calls).toBe(2);
    expect(existsSync(join(checkout, "stray-1.txt"))).toBe(false);
    expect(existsSync(join(checkout, "stray-2.txt"))).toBe(false);
    expect(existsSync(join(repo, "stray-1.txt"))).toBe(false);
    await disposeCheckouts(ctx);
    expect(existsSync(checkout)).toBe(false);
  });

  it("never reverts or deletes work done in the checkout under review during the call", async () => {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    let repo = "";
    // While the reviewer reads, a person edits a tracked file and creates a
    // file in the checkout under review (the E1-1 failure case).
    const person = {
      ...answering("codex"),
      review: (r: AdapterRequest) => {
        writeFileSync(join(repo, "README.md"), "SYNTHETIC edit by a person\n");
        writeFileSync(join(repo, "SYNTHETIC_new.py"), "print('mine')\n");
        return answering("codex").review(r);
      },
    } as VendorAdapter;
    const h = await makeRun({ adapters: { codex: person } });
    repo = h.repo;
    const out = await h.ctx.callAgent<ReviewOutput>({
      key: "k",
      role: "reviewer",
      vendor: "codex",
      method: "review",
      request: { prompt: "p", repoPath: await readOnlyRepo(h.ctx), toolPolicy: "read-only" },
      groupId: null,
      estimateTokens: 1,
    });
    expect(out.vendor).toBe("codex");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("SYNTHETIC edit by a person\n");
    expect(readFileSync(join(repo, "SYNTHETIC_new.py"), "utf8")).toBe("print('mine')\n");
    await disposeCheckouts(h.ctx);
  });

  it("only reports a change to the checkout under review, and keeps every file", async () => {
    const { existsSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    let calls = 0;
    const editing = {
      ...answering("codex"),
      review: (r: AdapterRequest) => {
        calls += 1;
        writeFileSync(join(r.repoPath, `SYNTHETIC_stray-${calls}.txt`), "x");
        return answering("codex").review(r);
      },
    } as VendorAdapter;
    const { ctx, repo } = await makeRun({ adapters: { codex: editing } });
    const call = ctx.callAgent<ReviewOutput>({
      key: "k",
      role: "reviewer",
      vendor: "codex",
      method: "review",
      request: { prompt: "p", repoPath: repo, toolPolicy: "read-only" },
      groupId: null,
      estimateTokens: 1,
    });
    await expect(call).rejects.toThrow(/doesn't own this worktree/);
    expect(existsSync(join(repo, "SYNTHETIC_stray-1.txt"))).toBe(true);
    expect(existsSync(join(repo, "SYNTHETIC_stray-2.txt"))).toBe(true);
  });

  it("may write in the run directory", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { ctx } = await makeRun({ adapters: {} });
    const scratch = ctx.store.scratchDir("F-0001");
    const writing = {
      ...answering("codex"),
      review: (r: AdapterRequest) => {
        mkdirSync(scratch, { recursive: true });
        writeFileSync(join(scratch, "repro.py"), "x");
        return answering("codex").review(r);
      },
    } as VendorAdapter;
    ctx.deps.adapters.codex = writing;
    await expect(
      ctx.callAgent<ReviewOutput>({
        key: "k",
        role: "reviewer",
        vendor: "codex",
        method: "review",
        request: { prompt: "p", repoPath: ctx.state.request.repoPath, toolPolicy: "read-only" },
        groupId: null,
        estimateTokens: 1,
      }),
    ).resolves.toMatchObject({ vendor: "codex" });
  });
});

describe("usage from failed calls", () => {
  it("records the samples a failed call reported", async () => {
    const sample = {
      vendor: "codex" as const,
      account: "codex/work",
      window: "5h" as const,
      utilization: 0.2,
      spendUsd: null,
      ceiling: { kind: "utilization" as const, window: "5h" as const, max: 0.7 },
      resetAt: null,
      sampleSource: "codex_session" as const,
    };
    const adapter = {
      ...answering("codex"),
      vendor: "codex",
      review: () =>
        Promise.reject(Object.assign(new LimitError("usage limit"), { usage: [sample] })),
      detectLimit: (e: unknown) =>
        e instanceof LimitError ? { resetAt: null, message: "usage limit" } : null,
    } as unknown as VendorAdapter;
    const { ctx, events } = await makeRun({
      adapters: { codex: adapter, copilot: answering("copilot") },
    });
    await ctx.callAgent(review(ctx.state.request.repoPath));
    expect(events.ofType("usage.sample")[0]).toMatchObject({
      vendor: "codex",
      utilization: 0.2,
    });
  });
});

describe("assigning a role during a round", () => {
  it("moves a call that hasn't started, and collapses queued duplicates", async () => {
    const { ctx } = await makeRun({
      adapters: { codex: answering("codex"), copilot: answering("copilot") },
    });
    await ctx.assignNow("disprover", ["codex"]);
    await ctx.assignNow("disprover", ["copilot"]);
    expect(ctx.eng.pendingAssign).toEqual([{ role: "disprover", vendors: ["copilot"] }]);
    const out = await ctx.callAgent(review(ctx.state.request.repoPath));
    expect(out.vendor).toBe("copilot");
    expect(ctx.state.roles.disprover).toBe("copilot");
  });

  it("doesn't move a call to a vendor it must avoid", async () => {
    const { ctx } = await makeRun({
      adapters: { codex: answering("codex"), copilot: answering("copilot") },
    });
    await ctx.assignNow("disprover", ["copilot"]);
    const out = await ctx.callAgent({
      ...review(ctx.state.request.repoPath),
      avoid: ["copilot"],
    });
    expect(out.vendor).toBe("codex");
  });
});

describe("waiting out a ceiling", () => {
  it("asks the server again before the old reset time", async () => {
    let asks = 0;
    const granting = new GrantingBroker();
    const broker: LeaseBroker = {
      acquire: async (req) => {
        asks += 1;
        if (asks === 1) {
          return {
            decision: "pause",
            leaseId: req.leaseId,
            resumeAt: "2099-01-01T00:00:00.000Z",
            reason: "Over its ceiling.",
          };
        }
        return granting.acquire(req);
      },
      settle: () => undefined,
    };
    const { ctx } = await makeRun({ adapters: { codex: answering("codex") }, broker });
    await ctx.callAgent(review(ctx.state.request.repoPath));
    expect(asks).toBe(2);
    expect(ctx.state.status).toBe("running");
    expect(ctx.state.pausedUntil).toBeUndefined();
  });
});

describe("limit fallback", () => {
  it("doesn't offer a vendor a role it can't take", async () => {
    const copilot = answering("copilot");
    const { ctx } = await makeRun({ adapters: { codex: limited("codex"), copilot } });
    await expect(
      ctx.callAgent({
        ...review(ctx.state.request.repoPath),
        role: "confirmer",
        method: "confirm",
        vendor: "codex",
      }),
    ).rejects.toThrow(/kept hitting its limit/);
  });
});
