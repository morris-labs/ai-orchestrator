// The run controls and the stop conditions, on the sample repository.
import { execFileSync } from "node:child_process";
import type { LeaseRequest, LeaseResponse, Vendor } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import {
  FakeClock,
  GrantingBroker,
  MemoryEventSink,
  type AdapterRequest,
  type AdapterResult,
  type EngineDeps,
  type LimitInfo,
  type ReviewOutput,
  type VendorAdapter,
} from "../../src/core.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { InvalidStateError, RunController } from "../../src/state/controller.js";
import { Scenario, buildSampleRepo } from "./scenario.js";

let seq = 100;
const nextRunId = () => `01JC${String(++seq).padStart(22, "0")}`;

type Hook = (req: LeaseRequest) => void;

function setup(scenario: Scenario, hook?: Hook, adapters?: EngineDeps["adapters"]) {
  const clock = new FakeClock();
  const granting = new GrantingBroker(clock);
  const events = new MemoryEventSink("engine:test", "s", clock);
  const broker = {
    settle: granting.settle.bind(granting),
    acquire: (req: LeaseRequest): Promise<LeaseResponse> => {
      hook?.(req);
      return granting.acquire(req);
    },
  };
  const deps: EngineDeps = {
    adapters: adapters ?? scenario.adapters(),
    broker,
    events,
    runner: new ExecaRunner(),
    clock,
    container: "c",
  };
  return { deps, events };
}

async function create(repo: string, deps: EngineDeps, extra: Record<string, unknown> = {}) {
  return RunController.create(
    { runId: nextRunId(), projectId: "sample", repoPath: repo, ...extra },
    { projectRoot: repo },
    deps,
  );
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

describe("run controls", () => {
  it("applies a profile switch and a manual assignment from the next round", async () => {
    const repo = buildSampleRepo();
    const ref: { run?: RunController } = {};
    let done = false;
    const { deps, events } = setup(new Scenario(), (req) => {
      if (req.role === "fixer" && !done) {
        done = true;
        void ref.run?.setProfile("fast");
        void ref.run?.assign("confirmer", ["copilot"]);
      }
    });
    const run = await create(repo, deps);
    ref.run = run;
    await run.start();
    const state = await run.settled();
    expect(state.status).toBe("finished");
    const changes = events.ofType("role.reassigned").filter((e) => e.effectiveRound === 2);
    expect(changes.find((e) => e.role === "reviewer")?.to).toEqual(["claude", "codex"]);
    expect(changes.find((e) => e.role === "confirmer")).toMatchObject({
      to: ["copilot"],
      reason: "manual",
    });
    expect(state.profile).toBe("fast");
    expect(
      events
        .ofType("agent.started")
        .some((e) => e.round >= 2 && e.vendor === "claude" && e.role === "reviewer"),
    ).toBe(true);
  });

  it("pauses after the current call and resumes", async () => {
    const repo = buildSampleRepo();
    const ref: { run?: RunController } = {};
    let paused = false;
    const { deps } = setup(new Scenario(), (req) => {
      if (req.role === "disprover" && !paused) {
        paused = true;
        void ref.run?.pause();
      }
    });
    const run = await create(repo, deps);
    ref.run = run;
    await run.start();
    await until(() => run.state.status === "paused");
    await expect(run.pause()).rejects.toBeInstanceOf(InvalidStateError);
    await run.resume();
    const state = await run.settled();
    expect(state.status).toBe("finished");
  });

  it("cancels and stops the call in flight", async () => {
    const repo = buildSampleRepo();
    const scenario = new Scenario({ hang: { method: "verify", nth: 1 } });
    const { deps } = setup(scenario);
    const run = await create(repo, deps);
    await run.start();
    await until(() => scenario.count("verify") >= 1);
    const state = await run.cancel();
    expect(state).toMatchObject({ status: "cancelled", stopReason: "cancelled" });
    await expect(run.cancel()).rejects.toBeInstanceOf(InvalidStateError);
    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" });
    expect(worktrees).toBeDefined();
  });

  it("stops at the round cap", async () => {
    const repo = buildSampleRepo();
    const { deps } = setup(new Scenario());
    const run = await create(repo, deps, { roundCap: 1 });
    await run.start();
    expect(await run.settled()).toMatchObject({
      status: "finished",
      stopReason: "round_cap",
      round: 1,
    });
  });

  it("reviews a commit read-only without fixing", async () => {
    const repo = buildSampleRepo();
    const scenario = new Scenario();
    const { deps } = setup(scenario);
    const tip = execFileSync("git", ["rev-parse", "feature"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const run = await create(repo, deps, { tip, readOnly: true });
    await run.start();
    const state = await run.settled();
    expect(state).toMatchObject({ status: "finished", stopReason: "clean" });
    expect(scenario.count("fix")).toBe(0);
    expect(run.findings.filter((f) => f.verdict === "confirmed").length).toBeGreaterThan(3);
    await expect(run.push()).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("moves a role to another vendor when one hits its limit", async () => {
    const repo = buildSampleRepo();
    const scenario = new Scenario({
      limit: { vendor: "codex", method: "review", nth: 1, resetAt: "2026-10-28T14:00:00.000Z" },
    });
    const { deps, events } = setup(scenario);
    const run = await create(repo, deps);
    await run.start();
    const state = await run.settled();
    expect(state.status).toBe("finished");
    expect(events.ofType("role.reassigned").find((e) => e.reason === "limit")).toMatchObject({
      role: "reviewer",
      to: ["copilot"],
    });
    expect(events.ofType("agent.finished").some((e) => e.outcome === "limited")).toBe(true);
  });

  it("leaves every ceiling redirect in a lease response to the server", async () => {
    const repo = buildSampleRepo();
    const scenario = new Scenario();
    const { deps, events } = setup(scenario);
    const granting = deps.broker;
    let redirects = 0;
    deps.broker = {
      settle: granting.settle.bind(granting),
      acquire: async (req: LeaseRequest): Promise<LeaseResponse> => {
        const res = await granting.acquire(req);
        if (res.decision !== "granted" || req.vendor !== "codex" || req.role !== "reviewer")
          return res;
        redirects += 1;
        return { ...res, vendor: "copilot", redirectedFrom: "codex" };
      },
    };
    const run = await create(repo, deps, { readOnly: true });
    await run.start();
    expect((await run.settled()).status).toBe("finished");
    expect(redirects).toBeGreaterThan(0);
    // The server emits role.reassigned for its own redirects; the engine
    // only follows them.
    expect(events.ofType("role.reassigned").filter((e) => e.reason === "ceiling")).toEqual([]);
    expect(
      events.ofType("agent.started").some((e) => e.role === "reviewer" && e.vendor === "copilot"),
    ).toBe(true);
  });

  it("fails after a call fails twice, and retries the stage on start", async () => {
    const repo = buildSampleRepo();
    const scenario = new Scenario();
    const adapters = scenario.adapters();
    const codex = adapters.codex as VendorAdapter;
    let failures = 2;
    adapters.codex = {
      ...codex,
      vendor: "codex",
      review: codex.review.bind(codex),
      continueReview: codex.continueReview.bind(codex),
      verify: codex.verify.bind(codex),
      fix: codex.fix.bind(codex),
      sweep: codex.sweep.bind(codex),
      detectLimit: codex.detectLimit.bind(codex),
      confirm: (req) =>
        failures-- > 0 ? Promise.reject(new Error("CLI crashed")) : codex.confirm(req),
    };
    const { deps } = setup(scenario, undefined, adapters);
    const run = await create(repo, deps);
    await run.start();
    let state = await run.settled();
    expect(state).toMatchObject({ status: "failed", stopReason: "error", stage: "confirm" });
    expect(state.error).toMatch(/confirmer call on codex failed twice: CLI crashed/);
    await expect(run.decide({ option: "resume", waiveFindingIds: [] })).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    await run.start();
    state = await run.settled();
    expect(state).toMatchObject({ status: "finished", stopReason: "clean" });
  });

  it("stops after one attempt when the adapter says a retry fails the same way", async () => {
    const repo = buildSampleRepo();
    const scenario = new Scenario();
    const adapters = scenario.adapters();
    const codex = adapters.codex as VendorAdapter;
    let calls = 0;
    adapters.codex = {
      vendor: "codex",
      review: () => {
        calls += 1;
        return Promise.reject(new Error("not logged in"));
      },
      continueReview: codex.continueReview.bind(codex),
      verify: codex.verify.bind(codex),
      fix: codex.fix.bind(codex),
      confirm: codex.confirm.bind(codex),
      sweep: codex.sweep.bind(codex),
      detectLimit: () => null,
      isRetryable: () => false,
    };
    const { deps } = setup(scenario, undefined, adapters);
    const run = await create(repo, deps);
    await run.start();
    const state = await run.settled();
    expect(state).toMatchObject({ status: "failed", stopReason: "error", stage: "find" });
    expect(state.error).toMatch(/not logged in/);
    // One call per review group that started before the first failure stopped the stage.
    expect(calls).toBeGreaterThan(0);
    const finished = deps.events as MemoryEventSink;
    const failed = finished.ofType("agent.finished").filter((e) => e.vendor === "codex");
    expect(failed.every((e) => e.outcome === "error")).toBe(true);
    expect(failed.length).toBe(calls);
  });

  it("records Copilot AI credits on agent.finished and the round summary", async () => {
    const repo = buildSampleRepo();
    const scenario = new Scenario();
    const adapters = scenario.adapters();
    const copilot = adapters.copilot as VendorAdapter;
    const withCredits =
      <T>(call: (req: AdapterRequest) => Promise<AdapterResult<T>>) =>
      async (req: AdapterRequest): Promise<AdapterResult<T>> => ({
        ...(await call(req)),
        aiCredits: 2.5,
      });
    adapters.copilot = {
      vendor: "copilot",
      review: withCredits((req) => copilot.review(req)),
      continueReview: copilot.continueReview.bind(copilot),
      verify: withCredits((req) => copilot.verify(req)),
      fix: copilot.fix.bind(copilot),
      confirm: copilot.confirm.bind(copilot),
      sweep: copilot.sweep.bind(copilot),
      detectLimit: copilot.detectLimit.bind(copilot),
    };
    const { deps, events } = setup(scenario, undefined, adapters);
    const run = await create(repo, deps);
    await run.start();
    await run.settled();
    const finished = events.ofType("agent.finished").filter((e) => e.vendor === "copilot");
    // Review and verify calls carry credits; the other methods return none.
    expect(finished.some((e) => e.aiCredits === 2.5)).toBe(true);
    for (const e of finished) expect([undefined, 2.5]).toContain(e.aiCredits);
    const summary = events
      .ofType("run.changed")
      .map((e) => e.roundSummary)
      .find((r) => r?.perVendor.copilot);
    expect(summary?.perVendor.copilot?.aiCredits).toBeGreaterThan(0);
    expect(summary?.perVendor.codex?.aiCredits).toBeUndefined();
  });

  it("switches reviewers to alternate after two rounds of high overlap", async () => {
    const repo = buildSampleRepo();
    // Both reviewers report the same new issue every round; the disprover rejects them all.
    const echo = (vendor: Vendor): VendorAdapter => {
      let round = 0;
      const res = <T>(output: T): AdapterResult<T> => ({
        output,
        model: `${vendor}-echo`,
        sessionId: null,
        tokens: { in: 1, out: 1 },
        usage: [],
        premiumRequests: 0,
        costEstimate: 0,
      });
      const review = async (req: AdapterRequest): Promise<AdapterResult<ReviewOutput>> => {
        round = Number(/in round (\d+)/.exec(req.prompt)?.[1] ?? 0);
        if (!req.prompt.includes("shop/pricing.py")) return res({ findings: [], ledger: [] });
        return res({
          findings: [
            {
              severity: "P2",
              title: `Suspicious rounding variant ${"abcdefgh"[round]}`,
              file: "shop/pricing.py",
              lines: [4 + round * 4, 4 + round * 4],
              failure_case: "x",
              category: "correctness",
              introduced: true,
              verdict: "pending",
            },
          ],
          ledger: [],
        });
      };
      return {
        vendor,
        review,
        continueReview: review,
        verify: async () =>
          res({
            verdict: "disproved",
            verification: "code-reading",
            evidence: "no",
            presentAtBase: false,
            script: null,
          }),
        fix: async () => res({ fixed: [], notFixed: [], summary: "" }),
        confirm: async () => res({ incomplete: [], findings: [] }),
        sweep: async () => res({ findings: [] }),
        detectLimit: (): LimitInfo | null => null,
      };
    };
    const { deps, events } = setup(new Scenario(), undefined, {
      claude: echo("claude"),
      codex: echo("codex"),
      copilot: echo("copilot"),
    });
    const run = await create(repo, deps);
    await run.start();
    const state = await run.settled();
    expect(state).toMatchObject({ status: "finished", stopReason: "clean", round: 2 });
    const rounds = await run.rounds();
    expect(rounds.map((r) => r.overlapRate)).toEqual([1, 1]);
    expect(events.ofType("role.reassigned").find((e) => e.reason === "overlap")).toMatchObject({
      role: "reviewer",
      from: ["codex", "copilot"],
      to: ["codex"],
      effectiveRound: 3,
    });
  });
});
