// The run manager over real run controllers: a read-only run on the sample
// repository with mock vendors through the adapter bridge, and the API
// error mapping.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventSchema, FindingSchema, RunStateSchema } from "@aio/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/main/logger.js";
import { bridgeAdapters } from "../../src/adapters/bridge.js";
import { GrantingBroker, MemoryEventSink } from "../../src/core.js";
import { createMockAdapters } from "../../src/main/adapters.js";
import { RangeError } from "../../src/range/resolve.js";
import { EngineRunManager, createRunManager, toApiError } from "../../src/state/manager.js";
import { EngineError } from "../../src/api/core-interface.js";
import { RunStore } from "../../src/run/store.js";
import { tempDir } from "../tmp.js";
import { PolicyError } from "../../src/policy/load.js";
import { buildSampleRepo } from "./scenario.js";
import { uniqueRunId } from "./run-ids.js";

const SCRIPT = join(import.meta.dirname, "../smoke/mock-script.json");
const RUN_A = uniqueRunId();
const RUN_B = uniqueRunId();

function manager(repo: string, policyPath?: string) {
  const events = new MemoryEventSink("engine:test", "stream-test");
  const broker = new GrantingBroker();
  const runs = new EngineRunManager({
    projectRoot: repo,
    ...(policyPath ? { policyPath } : {}),
    container: "aio-agent-proj-sample",
    events,
    leases: broker,
    adapters: bridgeAdapters(createMockAdapters(SCRIPT)),
    log: silentLogger,
  });
  return { runs, events, broker };
}

async function waitFor(runs: EngineRunManager, runId: string) {
  for (let i = 0; i < 600; i++) {
    const state = await runs.get(runId);
    if (state && !["pending", "running"].includes(state.status)) return state;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} didn't settle`);
}

describe("newer saved run state", () => {
  it("stays stopped after startup with a visible version notice and refuses resume without rewriting files", async () => {
    const root = tempDir("aio-newer-state-");
    const store = new RunStore(root, RUN_A);
    const saved = JSON.parse(
      readFileSync(join(import.meta.dirname, "../run/fixtures/v1.json"), "utf8"),
    );
    await store.writeJson("state.json", {
      ...saved,
      id: RUN_A,
      status: "running",
      stateVersion: 99,
    });
    await store.writeJson("engine.json", { futureBookkeeping: true });
    const before = readFileSync(store.path("state.json"), "utf8");
    const { runs } = manager(root);
    await runs.init();
    expect(runs.activeRunCount()).toBe(0);
    expect(await runs.get(RUN_A)).toMatchObject({
      status: "paused",
      error: expect.stringContaining("state version 99"),
    });
    expect(await runs.list({})).toMatchObject([
      { id: RUN_A, status: "paused", error: expect.stringContaining("state version 99") },
    ]);
    await expect(runs.resume(RUN_A)).rejects.toMatchObject({
      code: "invalid_state",
      message: expect.stringContaining("state version 99"),
    });
    expect(readFileSync(store.path("state.json"), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(store.path("engine.json"), "utf8"))).toEqual({
      futureBookkeeping: true,
    });
  });
});

describe("EngineRunManager", () => {
  let repo: string;
  let ctx: ReturnType<typeof manager>;

  beforeAll(async () => {
    repo = buildSampleRepo();
    ctx = manager(repo);
    await ctx.runs.start({
      runId: RUN_A,
      projectId: "sample",
      depth: "thorough",
      repoPath: repo,
      base: "origin/main",
      readOnly: true,
    } as never);
    await waitFor(ctx.runs, RUN_A);
  });

  it("drives a read-only run to the end with mock vendors", async () => {
    const state = RunStateSchema.parse(await ctx.runs.get(RUN_A));
    expect(state.status).toBe("finished");
    expect(state.error).toBeUndefined();
    expect(ctx.runs.activeRunCount()).toBe(0);
    for (const event of ctx.events.events) EventSchema.parse(event);
  });

  it("keeps the vendor's symbol and settles the confirmed and disproved findings", async () => {
    const findings = await ctx.runs.findings(RUN_A, {});
    for (const f of findings) FindingSchema.parse(f);
    const real = findings.find((f) => f.title.startsWith("average_price"));
    const fp = findings.find((f) => f.title.startsWith("apply_discount"));
    expect(real).toMatchObject({ verdict: "confirmed", symbol: "average_price" });
    expect(fp).toMatchObject({ verdict: "disproved" });
    expect(fp?.symbol).toBeUndefined();
    expect(await ctx.runs.findings(RUN_A, { verdict: "disproved" })).toEqual([fp]);
  });

  it("lists runs and filters them", async () => {
    expect((await ctx.runs.list({})).map((r) => r.id)).toEqual([RUN_A]);
    expect(await ctx.runs.list({ status: "running" })).toEqual([]);
    expect(await ctx.runs.list({ projectId: "other" })).toEqual([]);
  });

  it("returns a finding's diff and null for unknown findings and runs", async () => {
    const [first] = await ctx.runs.findings(RUN_A, {});
    const detail = await ctx.runs.finding(RUN_A, first!.id);
    expect(detail?.diff).toContain("shop/pricing.py");
    expect(detail?.fixDiff).toBeNull();
    expect(await ctx.runs.finding(RUN_A, "F-9999")).toBeNull();
    expect(await ctx.runs.finding("../../etc", "F-0001")).toBeNull();
    expect(await ctx.runs.get("../escape")).toBeNull();
  });

  it("serves the run's usage samples with the sample source kept", async () => {
    const samples = await ctx.runs.usageSamples({});
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0]).toMatchObject({ vendor: "codex", sampleSource: "codex_session" });
    expect(await ctx.runs.usageSamples({ vendor: "claude" })).toEqual([]);
    expect(await ctx.runs.usageSamples({ since: "2999-01-01T00:00:00Z" })).toEqual([]);
    const usage = ctx.events.ofType("usage.sample")[0];
    expect(usage?.source).toBe("engine:test");
  });

  it("previews the range with groups and a clean tree", async () => {
    const preview = await ctx.runs.preview({
      projectId: "sample",
      depth: "thorough",
      repoPath: repo,
      base: "origin/main",
      readOnly: true,
    } as never);
    expect(preview.dirty).toBe(false);
    expect(preview.groups.length).toBeGreaterThan(0);
    expect(preview.changedLines).toBe(preview.groups.reduce((n, g) => n + g.changedLines, 0));
  });

  it("previews the effective reviewer effort for the resolved tier model", async () => {
    const policyPath = join(tempDir("aio-preview-effort-"), "policy.yaml");
    writeFileSync(policyPath, 'version: 1\ntierModels:\n  codex:\n    large: "gpt-5.5"\n');
    const { runs } = manager(repo, policyPath);
    const preview = await runs.preview({
      projectId: "sample",
      repoPath: repo,
      base: "origin/main",
      readOnly: true,
      modelTier: "large",
      roles: { reviewer: ["codex"] },
      reviewerEffort: "max",
    } as never);
    expect(preview.reviewerEfforts).toEqual([
      {
        vendor: "codex",
        model: "gpt-5.5",
        effort: "xhigh",
        note: "The codex call uses xhigh effort instead of max.",
      },
    ]);
  });

  it.each([
    { scope: undefined, includeWorktree: false },
    { scope: undefined, includeWorktree: true },
    { scope: "whole", includeWorktree: false },
    { scope: "whole", includeWorktree: true },
  ] as const)(
    "previews the groups and tiers for $scope scope with working tree $includeWorktree",
    async (options) => {
      const repoPath = buildSampleRepo();
      const { runs } = manager(repoPath);
      if (options.includeWorktree) {
        writeFileSync(join(repoPath, "untracked.py"), "VALUE = 42\n");
      }
      const request = {
        projectId: "sample",
        depth: "thorough",
        repoPath,
        base: "origin/main",
        readOnly: true,
        roundCap: 1,
        ...options,
      };
      const runId = uniqueRunId();
      const preview = await runs.preview(request as never);
      await runs.start({ ...request, runId } as never);
      expect(await waitFor(runs, runId)).toMatchObject({ status: "finished" });
      const groups = await runs.groups(runId);
      expect(groups.length).toBeGreaterThan(0);
      expect(preview.groups).toEqual(groups);
      if (options.includeWorktree) {
        expect(groups.flatMap((group) => group.files)).toContain("untracked.py");
      }
    },
  );

  it("refuses a duplicate run id and actions on unknown runs", async () => {
    await expect(
      ctx.runs.start({
        runId: RUN_A,
        projectId: "sample",
        repoPath: repo,
        depth: "thorough",
      } as never),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(ctx.runs.pause(RUN_B)).rejects.toMatchObject({ code: "run_not_found" });
    await expect(ctx.runs.waive(RUN_A, "F-9999", "x")).rejects.toMatchObject({ code: "not_found" });
    await expect(ctx.runs.resume(RUN_A)).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("maps a bad base to validation", async () => {
    await expect(
      ctx.runs.start({
        runId: RUN_B,
        projectId: "sample",
        depth: "thorough",
        repoPath: repo,
        base: "no-such-ref",
        readOnly: true,
      } as never),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("loads finished runs from disk in a new manager", async () => {
    const fresh = await createRunManager({
      projectRoot: repo,
      container: "c",
      events: new MemoryEventSink(),
      leases: new GrantingBroker(),
      adapters: {},
      log: silentLogger,
    });
    expect(fresh.activeRunCount()).toBe(0);
    expect((await fresh.get(RUN_A))?.status).toBe("finished");
    const state = JSON.parse(
      readFileSync(join(repo, ".aio/runs", RUN_A, "state.json"), "utf8"),
    ) as { status: string };
    expect(state.status).toBe("finished");
  });
});

describe("toApiError", () => {
  it("keeps dirty_tree and turns other range, policy, and git errors into validation", () => {
    const dirty = new RangeError("dirty_tree", "dirty");
    expect(toApiError(dirty)).toBe(dirty);
    expect(toApiError(new RangeError("bad_ref", "bad"))).toMatchObject({ code: "validation" });
    expect(toApiError(new PolicyError("p", "bad"))).toBeInstanceOf(EngineError);
    const other = new Error("x");
    expect(toApiError(other)).toBe(other);
  });
});
