// The merge stage across a crash: the same candidates never merge twice.
import { describe, expect, it } from "vitest";
import { RunController } from "../../src/state/controller.js";
import { mergeInto, runSweep, toCandidates } from "../../src/state/steps.js";
import { contextOf, makeRun } from "./harness.js";

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
    const persist = ctx.persist.bind(ctx);
    ctx.persist = () => Promise.reject(new Error("engine stopped"));
    await expect(
      mergeInto(ctx, await toCandidates(ctx, raw, "reviewer", []), "merge"),
    ).rejects.toThrow();
    ctx.persist = persist;
    const reloaded = contextOf(await RunController.load(ctx.state.id, { projectRoot: repo }, deps));
    expect(reloaded.findings).toHaveLength(0);
    const result = await mergeInto(reloaded, () => Promise.reject(new Error("unused")), "merge");
    expect(result.created).toEqual(["F-0001"]);
    expect(reloaded.findings.map((f) => f.id)).toEqual(["F-0001"]);
    expect(reloaded.eng.counters.finding).toBe(1);
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
});
