// The merge stage across a crash: the same candidates never merge twice.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Vendor } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import type { VendorAdapter } from "../../src/core.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { Git } from "../../src/range/git.js";
import { RunController } from "../../src/state/controller.js";
import {
  mergeInto,
  runConfirm,
  runSweep,
  toCandidates,
  verifyPending,
} from "../../src/state/steps.js";
import { contextOf, makeRun } from "./harness.js";
import { Scenario, buildSampleRepo } from "./scenario.js";

const raw = [
  {
    finding: {
      severity: "P1" as const,
      title: "Total ignores the discount",
      file: "shop/cart.py",
      lines: [3, 4] as [number, number],
      failure_case: "A discounted cart charges full price.",
      category: "logic",
      introduced: true,
      verdict: "pending" as const,
    },
    vendor: "codex" as const,
    model: "codex",
    groupId: null,
  },
];

describe("mergeInto", () => {
  it("returns the saved result when the stage reruns after its findings were saved", async () => {
    const { ctx } = await makeRun();
    ctx.state.round = 1;
    const first = await mergeInto(ctx, await toCandidates(ctx, raw, "reviewer", []), "merge");
    expect(first.created).toEqual(["F-0001"]);
    // The engine stopped before merge.json; the stage runs again.
    const again = await mergeInto(ctx, await toCandidates(ctx, raw, "reviewer", []), "merge");
    expect(again.created).toEqual(["F-0001"]);
    expect(again.duplicates).toEqual([]);
    expect(ctx.findings).toHaveLength(1);
  });

  it("restores the merge when the engine stopped before the findings were saved", async () => {
    const { ctx, deps, repo } = await makeRun();
    ctx.state.round = 1;
    await ctx.persist();
    const candidates = await toCandidates(ctx, raw, "reviewer", []);
    const persist = ctx.persist.bind(ctx);
    ctx.persist = () => Promise.reject(new Error("engine stopped"));
    await expect(mergeInto(ctx, candidates, "merge")).rejects.toThrow("engine stopped");
    ctx.persist = persist;
    const reloaded = contextOf(await RunController.load(ctx.state.id, { projectRoot: repo }, deps));
    expect(reloaded.findings).toHaveLength(0);
    const result = await mergeInto(reloaded, () => Promise.reject(new Error("unused")), "merge");
    expect(result.created).toEqual(["F-0001"]);
    expect(reloaded.findings.map((f) => f.id)).toEqual(["F-0001"]);
    expect(reloaded.eng.counters.finding).toBe(1);
  });

  // Finding 50: the merge was marked as applied before the announcements,
  // so an engine that stopped in between never announced the new findings.
  it("announces the new findings when the engine stopped before announcing them", async () => {
    const { ctx, deps, repo, events } = await makeRun();
    ctx.state.round = 1;
    await ctx.persist();
    ctx.announceFinding = () => Promise.reject(new Error("engine stopped"));
    await expect(
      mergeInto(ctx, await toCandidates(ctx, raw, "reviewer", []), "merge"),
    ).rejects.toThrow();
    const reloaded = contextOf(await RunController.load(ctx.state.id, { projectRoot: repo }, deps));
    await mergeInto(reloaded, () => Promise.reject(new Error("unused")), "merge");
    const announced = events.events.flatMap((e) =>
      e.type === "finding.changed" && e.previousVerdict === null ? [e.finding.id] : [],
    );
    expect(announced).toEqual(["F-0001"]);
    expect(reloaded.eng.appliedMerges).toHaveLength(1);
  });
});

describe("runConfirm", () => {
  it("merges the confirmer's findings when the engine stopped after the verdicts", async () => {
    const confirmed = {
      severity: "P2" as const,
      title: "Refund skips the tax",
      file: "shop/cart.py",
      lines: [5, 6] as [number, number],
      failure_case: "A refund returns the net price.",
      category: "logic",
      introduced: true,
      verdict: "pending" as const,
    };
    const adapter = (vendor: Vendor): VendorAdapter =>
      ({
        vendor,
        confirm: () =>
          Promise.resolve({
            output: { incomplete: [], findings: [confirmed] },
            model: vendor,
            sessionId: null,
            tokens: { in: 1, out: 1 },
            usage: [],
            premiumRequests: 0,
            costEstimate: 0,
          }),
        detectLimit: () => null,
      }) as unknown as VendorAdapter;
    const { ctx, deps, repo } = await makeRun({
      adapters: { claude: adapter("claude"), codex: adapter("codex"), copilot: adapter("copilot") },
    });
    ctx.state.round = 1;
    await mergeInto(ctx, await toCandidates(ctx, raw, "reviewer", []), "merge");
    const head = await ctx.git.head();
    const target = ctx.findingById("F-0001")!;
    target.verdict = "confirmed";
    target.fixCommit = head;
    ctx.eng.preFixSha = head;
    await ctx.persist();
    // The engine stops after the verdicts, before the confirmer's merge.
    const writeJson = ctx.store.writeJson.bind(ctx.store);
    ctx.store.writeJson = (name, value) =>
      name.includes("confirm-commit")
        ? Promise.reject(new Error("engine stopped"))
        : writeJson(name, value);
    await expect(runConfirm(ctx, [])).rejects.toThrow("engine stopped");
    expect(ctx.findingById("F-0001")?.verdict).toBe("fixed");

    const reloaded = contextOf(await RunController.load(ctx.state.id, { projectRoot: repo }, deps));
    const record = await runConfirm(reloaded, []);
    expect(record.fixedIds).toEqual(["F-0001"]);
    expect(record.created).toHaveLength(1);
    expect(reloaded.findings.map((f) => f.title)).toContain("Refund skips the tax");
    // The verdict isn't set twice.
    const fixedEntries = reloaded
      .findingById("F-0001")!
      .history.filter((h) => h.verdict === "fixed");
    expect(fixedEntries).toHaveLength(1);
  });
});

describe("verifyPending", () => {
  it("keeps the results from before a restart in the stage file", async () => {
    const { ctx } = await makeRun();
    ctx.state.round = 1;
    const file = ctx.store.roundFile(1, "verify");
    const earlier = {
      findingId: "F-0001",
      vendor: "codex",
      model: "codex",
      decision: { verdict: "confirmed", evidence: "SYNTHETIC" },
      tipRun: null,
      baseRun: null,
    };
    await ctx.store.writeJson(file, [earlier]);
    // F-0001 got its verdict before the restart, so nothing is pending now.
    expect(await verifyPending(ctx, file)).toEqual([]);
    expect(await ctx.store.readJson(file)).toEqual([earlier]);
  });
});

describe("runSweep", () => {
  it("caches a sweep with no patterns", async () => {
    const { ctx } = await makeRun();
    ctx.state.round = 1;
    expect(await runSweep(ctx, [])).toBeNull();
    expect(await ctx.store.readJson(ctx.store.roundFile(1, "sweep"))).toEqual({ skipped: true });
    expect(await runSweep(ctx, [])).toBeNull();
  });

  it("hands a large diff to the sweeper in a file that holds the measured diff", async () => {
    const prompts: string[] = [];
    const extraDirs: (string[] | undefined)[] = [];
    const repo = buildSampleRepo();
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    const commit = (path: string, content: string) => {
      writeFileSync(join(repo, path), content);
      git("add", path);
      git("commit", "-qm", "Add file");
    };
    const branchPoint = git("rev-parse", "main");
    git("switch", "-qc", "advanced-main", "main");
    commit("upstream.txt", "upstream only\n");
    git("switch", "-q", "feature");
    const big = Array.from({ length: 40_000 }, (_, i) => `line ${i} of a large change`).join("\n");
    commit("big.txt", `${big}\n`);
    const tip = git("rev-parse", "HEAD");
    const scenario = new Scenario();
    const adapters = scenario.adapters();
    for (const adapter of Object.values(adapters)) {
      const sweep = adapter.sweep.bind(adapter);
      adapter.sweep = (request) => {
        prompts.push(request.prompt);
        extraDirs.push(request.extraDirs);
        return sweep(request);
      };
    }
    const { run } = await makeRun({
      repo,
      adapters,
      request: { base: "advanced-main", readOnly: true, roundCap: 1 },
    });
    await run.start();
    expect(await run.settled()).toMatchObject({ status: "finished" });
    const prompt = prompts[0]!;
    const path = join(run.runDir, "rounds/1/sweep.diff");
    expect(prompt).toContain(path);
    expect(prompt).not.toContain("git -C");
    // The run store is outside the checkout, so the sweeper must be allowed to read it.
    expect(extraDirs[0]).toEqual([dirname(path)]);
    const written = readFileSync(path, "utf8");
    expect(written).toBe(await new Git(new ExecaRunner(), repo).diffForPrompt(branchPoint, tip));
    expect(written).not.toContain("upstream only");
  });
});
