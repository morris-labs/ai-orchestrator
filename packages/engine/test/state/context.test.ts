// RunContext: agent calls, leases, and persistence.
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { LeaseRequest, LeaseResponse, Vendor } from "@aio/contracts";
import {
  GrantingBroker,
  type AdapterRequest,
  type AdapterResult,
  type Clock,
  type LeaseActual,
  type LeaseBroker,
  type ReviewOutput,
  type VendorAdapter,
} from "../../src/core.js";
import { EngineLeaseBroker } from "../../src/events/leases.js";
import { DecisionNeeded, RunCancelled, describeError } from "../../src/state/context.js";
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

  it("asks a person instead of using the avoided vendor when it is the only other one", async () => {
    const { ctx, events } = await makeRun({
      adapters: { codex: limited("codex"), copilot: answering("copilot") },
    });
    await expect(
      ctx.callAgent(review(ctx.state.request.repoPath, { avoid: ["copilot"] })),
    ).rejects.toBeInstanceOf(DecisionNeeded);
    expect(events.ofType("agent.started").map((e) => e.vendor)).toEqual(["codex"]);
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

/** A clock whose sleeps end only when a test releases them or their signal aborts. */
class ManualClock implements Clock {
  readonly sleepers: Array<() => void> = [];

  now(): number {
    return Date.parse("2026-10-28T09:00:00Z");
  }

  sleep(_ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      this.sleepers.push(resolve);
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
}

const LATER = "2026-10-28T12:00:00.000Z";

const pausingBroker: LeaseBroker = {
  acquire: (req) =>
    Promise.resolve({
      decision: "pause",
      leaseId: req.leaseId,
      resumeAt: LATER,
      reason: "Over its ceiling.",
    }),
  settle: () => undefined,
};

describe("timed waits", () => {
  /** Runs `act` while the run saves its `paused` status, before the wait can start. */
  function duringPausedSave(ctx: Awaited<ReturnType<typeof makeRun>>["ctx"], act: () => void) {
    const saveState = ctx.store.saveState.bind(ctx.store);
    ctx.store.saveState = (state) => {
      if (state.status === "paused") act();
      return saveState(state);
    };
  }

  it("ends pauseUntil at once for a cancel that lands while the status saves", async () => {
    const clock = new ManualClock();
    const { ctx } = await makeRun({ adapters: {}, deps: { clock } });
    duringPausedSave(ctx, () => ctx.requestCancel());
    await expect(ctx.pauseUntil(LATER)).rejects.toBeInstanceOf(RunCancelled);
    expect(clock.sleepers).toHaveLength(0);
  });

  it("ends acquireLease at once for a cancel that lands while the status saves", async () => {
    const clock = new ManualClock();
    const { ctx } = await makeRun({ adapters: {}, broker: pausingBroker, deps: { clock } });
    duringPausedSave(ctx, () => ctx.requestCancel());
    await expect(ctx.acquireLease("codex", "reviewer", 1)).rejects.toBeInstanceOf(RunCancelled);
    expect(clock.sleepers).toHaveLength(0);
  });

  it("doesn't sleep after a cancel that came before the wait", async () => {
    const clock = new ManualClock();
    const { ctx } = await makeRun({ adapters: {}, deps: { clock } });
    ctx.requestCancel();
    await expect(ctx.pauseUntil(LATER)).rejects.toBeInstanceOf(RunCancelled);
  });

  it("doesn't lose a wake that lands while the status saves", async () => {
    const clock = new ManualClock();
    const { ctx } = await makeRun({ adapters: {}, deps: { clock } });
    duringPausedSave(ctx, () => ctx.wakePause());
    await ctx.pauseUntil(LATER);
    expect(ctx.state.status).toBe("running");
    expect(clock.sleepers).toHaveLength(0);
  });

  it("wakes every parallel wait", async () => {
    const clock = new ManualClock();
    const { ctx } = await makeRun({ adapters: {}, deps: { clock } });
    const waits = [ctx.pauseUntil(LATER), ctx.pauseUntil(LATER), ctx.pauseUntil(LATER)];
    await vi.waitFor(() => expect(clock.sleepers).toHaveLength(3));
    ctx.wakePause();
    await Promise.all(waits);
    expect(ctx.state.status).toBe("running");
    expect(ctx.state.pausedUntil).toBeUndefined();
  });

  it("stays paused until the last parallel wait ends", async () => {
    const clock = new ManualClock();
    const { ctx } = await makeRun({ adapters: {}, deps: { clock } });
    const first = ctx.pauseUntil(LATER);
    const second = ctx.pauseUntil(LATER);
    await vi.waitFor(() => expect(clock.sleepers).toHaveLength(2));
    clock.sleepers[0]?.();
    await first;
    expect(ctx.state).toMatchObject({ status: "paused", pausedUntil: LATER });
    ctx.wakePause();
    await second;
    expect(ctx.state.status).toBe("running");
    expect(ctx.state.pausedUntil).toBeUndefined();
  });

  it("stays paused when a wait ends under a person's pause", async () => {
    const clock = new ManualClock();
    const { ctx } = await makeRun({ adapters: {}, deps: { clock } });
    ctx.requestPause();
    const atGate = ctx.checkpoint();
    const wait = ctx.pauseUntil(LATER);
    await vi.waitFor(() => expect(clock.sleepers).toHaveLength(1));
    clock.sleepers[0]?.();
    await wait;
    expect(ctx.state.status).toBe("paused");
    // The call that waited reaches the gate next, and doesn't announce it again.
    const alsoAtGate = ctx.checkpoint();
    ctx.requestResume();
    await Promise.all([atGate, alsoAtGate]);
    expect(ctx.state.status).toBe("running");
    expect(ctx.state.pausedUntil).toBeUndefined();
  });

  it("clears the end time when a person's pause follows a timed wait", async () => {
    const clock = new ManualClock();
    const { ctx } = await makeRun({ adapters: {}, deps: { clock } });
    await ctx.setStatus("paused", { pausedUntil: LATER });
    ctx.requestPause();
    const atGate = ctx.checkpoint();
    await vi.waitFor(() => expect(ctx.state.pausedUntil).toBeUndefined());
    ctx.requestResume();
    await atGate;
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
    ).rejects.toThrow(/No other usable vendor can take the confirmer call/);
  });
});

describe("a vendor that reports a limit", () => {
  const started = (events: { ofType: (t: "agent.started") => Array<{ vendor: Vendor }> }) =>
    events.ofType("agent.started").map((e) => e.vendor);

  /** A vendor whose calls report `limit`, counting them. */
  function reporting(vendor: Vendor, limit: { resetAt: string | null; kind?: string }) {
    const adapter = limited(vendor);
    adapter.detectLimit = () => ({ message: "usage limit", ...limit }) as never;
    return adapter;
  }

  it("isn't called again for the next finding", async () => {
    const { ctx, events } = await makeRun({
      adapters: {
        copilot: reporting("copilot", { resetAt: null, kind: "usage_limit" }),
        codex: answering("codex"),
      },
    });
    for (const key of ["a", "b", "c"]) {
      const out = await ctx.callAgent(
        review(ctx.state.request.repoPath, { key, vendor: "copilot" }),
      );
      expect(out.vendor).toBe("codex");
    }
    expect(started(events)).toEqual(["copilot", "codex", "codex", "codex"]);
  });

  it("stops the redirect loop: the server moved calls to the vendor at its quota", async () => {
    // Codex is over its ceiling. The server moves its calls to Copilot, whose
    // quota is gone, until the engine rules Copilot out.
    const asks: LeaseRequest[] = [];
    const resumeAt = "2099-01-01T00:00:00.000Z";
    const broker: LeaseBroker = {
      acquire: (req: LeaseRequest): Promise<LeaseResponse> => {
        asks.push(req);
        return Promise.resolve(
          req.exclude?.includes("copilot")
            ? { decision: "pause", leaseId: req.leaseId, resumeAt, reason: "Over the ceiling." }
            : {
                decision: "granted",
                leaseId: req.leaseId,
                vendor: "copilot",
                redirectedFrom: "codex",
                expiresAt: resumeAt,
              },
        );
      },
      settle: () => undefined,
    };
    const { ctx, events } = await makeRun({
      adapters: {
        claude: answering("claude"),
        codex: answering("codex"),
        copilot: reporting("copilot", { resetAt: null, kind: "usage_limit" }),
      },
      broker,
    });
    const call = ctx.callAgent(review(ctx.state.request.repoPath, { avoid: ["claude"] }));
    await expect.poll(() => ctx.state.status).toBe("paused");
    expect(ctx.state.pausedUntil).toBe(resumeAt);
    expect(started(events)).toEqual(["copilot"]);
    expect(asks.at(-1)?.exclude).toEqual(["copilot", "claude"]);
    ctx.requestCancel();
    await expect(call).rejects.toThrow();
  });

  it("pauses until a known reset when no vendor can take the call", async () => {
    const resetAt = "2099-01-01T00:00:00.000Z";
    const { ctx, clock } = await makeRun({
      adapters: { codex: reporting("codex", { resetAt, kind: "usage_limit" }) },
    });
    const sleeps: number[] = [];
    const sleep = clock.sleep.bind(clock);
    clock.sleep = (ms, signal) => {
      sleeps.push(ms);
      ctx.requestCancel();
      return sleep(ms, signal);
    };
    await expect(ctx.callAgent(review(ctx.state.request.repoPath))).rejects.toThrow();
    expect(ctx.state.pausedUntil).toBe(resetAt);
    expect(ctx.eng.limitedVendors.codex?.until).toBe(resetAt);
    // A timer can't hold a wait this long, so the wait is capped and checks again.
    expect(sleeps).toEqual([2_000_000_000]);
  });

  it("blocks a rate limit with no reset time for a while, not until a person acts", async () => {
    const { ctx, clock } = await makeRun({
      adapters: { codex: reporting("codex", { resetAt: null, kind: "rate_limit" }) },
    });
    const sleep = clock.sleep.bind(clock);
    clock.sleep = (ms, signal) => {
      ctx.requestCancel();
      return sleep(ms, signal);
    };
    const now = clock.now();
    await expect(ctx.callAgent(review(ctx.state.request.repoPath))).rejects.toThrow();
    expect(Date.parse(ctx.eng.limitedVendors.codex?.until ?? "")).toBe(now + 15 * 60_000);
  });

  it("gets a call again after a person assigns it the role", async () => {
    const { ctx, events } = await makeRun({
      adapters: {
        copilot: reporting("copilot", { resetAt: null, kind: "usage_limit" }),
        codex: answering("codex"),
      },
    });
    const repoPath = ctx.state.request.repoPath;
    await ctx.callAgent(review(repoPath, { key: "a", vendor: "copilot" }));
    await ctx.assignNow("reviewer", ["copilot"]);
    expect(ctx.eng.limitedVendors.copilot).toBeUndefined();
    await ctx.callAgent(review(repoPath, { key: "b", vendor: "copilot" }));
    expect(started(events).filter((v) => v === "copilot")).toHaveLength(2);
  });

  it("a call left over from a stopped driver starts nothing and changes no status", async () => {
    const { ctx, events } = await makeRun({ adapters: { codex: answering("codex") } });
    ctx.state.status = "failed";
    ctx.stopCalls();
    await expect(ctx.callAgent(review(ctx.state.request.repoPath))).rejects.toThrow();
    expect(events.ofType("agent.started")).toEqual([]);
    expect(ctx.state.status).toBe("failed");
    await ctx.beginDrive();
    await expect(ctx.callAgent(review(ctx.state.request.repoPath))).resolves.toBeDefined();
  });
});

describe("a build's review run under a limit", () => {
  const build = {
    buildId: "01JBQ8ZC5W3X4Y6Z7A8B9CDEFG",
    fixer: {
      placement: {
        seat: "developer",
        vendor: "claude",
        tier: "large",
        effort: "medium",
        sources: { vendor: "role", tier: "role", effort: "role" },
        fresh: true,
      },
      context: "The build's task context.",
    },
  };

  it("waits for the vendor's reset instead of moving the call to another vendor", async () => {
    const resetAt = "2099-01-01T00:00:00.000Z";
    const codex = limited("codex");
    codex.detectLimit = () => ({ message: "usage limit", resetAt, kind: "usage_limit" }) as never;
    const { ctx, events, clock } = await makeRun({
      adapters: { codex, copilot: answering("copilot"), claude: answering("claude") },
      request: { build },
    });
    clock.sleep = (_ms, _signal) => {
      ctx.requestCancel();
      return Promise.reject(new RunCancelled());
    };

    await expect(ctx.callAgent(review(ctx.state.request.repoPath))).rejects.toThrow();

    expect(events.ofType("agent.started").map((e) => e.vendor)).toEqual(["codex"]);
    expect(ctx.state.pausedUntil).toBe(resetAt);
  });

  it("moves a call off a quota with no reset time to another vendor", async () => {
    const { ctx, events } = await makeRun({
      adapters: { codex: limited("codex"), claude: answering("claude") },
      request: { build },
    });

    await ctx.callAgent(review(ctx.state.request.repoPath));

    expect(events.ofType("agent.started").map((e) => e.vendor)).toEqual(["codex", "claude"]);
    expect(events.ofType("role.reassigned")).toEqual([
      expect.objectContaining({
        role: "disprover",
        from: ["codex"],
        to: ["claude"],
        reason: "limit",
      }),
    ]);
  });

  it("asks a person about a quota with no reset time when no other vendor can take the call", async () => {
    const { ctx, events } = await makeRun({
      adapters: {
        codex: limited("codex"),
        copilot: limited("copilot"),
        claude: answering("claude"),
      },
      request: { build },
    });

    await expect(
      ctx.callAgent(review(ctx.state.request.repoPath, { avoid: ["claude"] })),
    ).rejects.toThrow(DecisionNeeded);

    expect(events.ofType("agent.started").map((e) => e.vendor)).toEqual(["codex", "copilot"]);
  });
});
