// The clean stop and the decisions that come before any stop.
import { FindingInputSchema, type Finding, type Verdict } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { DecisionNeeded } from "../../src/state/context.js";
import { drivePrePush, endRound } from "../../src/state/prepush.js";
import { makeRun } from "./harness.js";

function finding(id: string, verdict: Verdict, runId: string): Finding {
  return FindingInputSchema.parse({
    id,
    fingerprint: id,
    severity: "P1",
    title: `Bug ${id}`,
    file: "shop/cart.py",
    lines: [1, 2],
    failureCase: "It breaks.",
    category: "logic",
    introduced: true,
    reportedBy: "codex-x",
    verdict,
    evidence: "",
    runId,
    round: 1,
    groupId: null,
    origin: "reviewer",
  });
}

describe("the clean stop", () => {
  it("waits while a confirmed finding above nit is still unfixed", async () => {
    const { ctx } = await makeRun();
    ctx.state.round = 3;
    ctx.eng.cleanRounds = 1;
    ctx.findings.push(finding("F-0001", "confirmed", ctx.state.id));
    expect(await endRound(ctx)).toBeNull();
    expect(ctx.eng.cleanRounds).toBe(2);
  });

  it("waits while a finding is still pending", async () => {
    const { ctx } = await makeRun();
    ctx.state.round = 3;
    ctx.eng.cleanRounds = 1;
    ctx.findings.push(finding("F-0001", "pending", ctx.state.id));
    expect(await endRound(ctx)).toBeNull();
  });

  it("stops clean once nothing is open", async () => {
    const { ctx } = await makeRun();
    ctx.state.round = 3;
    ctx.eng.cleanRounds = 1;
    ctx.findings.push(finding("F-0001", "fixed", ctx.state.id));
    expect(await endRound(ctx)).toBe("clean");
  });
});

describe("an oscillation in the last round", () => {
  it("asks a person instead of finishing at the round cap", async () => {
    const { ctx } = await makeRun({ request: { roundCap: 2 } });
    ctx.state.round = 2;
    ctx.state.stage = "sweep";
    ctx.eng.roundOpen = true;
    ctx.findings.push(
      finding("F-0001", "fixed", ctx.state.id),
      finding("F-0002", "disproved", ctx.state.id),
    );
    await ctx.store.writeJson(ctx.store.roundFile(2, "sweep"), {
      round: 2,
      created: [],
      duplicates: [],
      known: [],
      oscillations: [{ fixedId: "F-0001", returnedId: "F-0002" }],
      overlapRate: 0,
      raisedByVendor: {},
    });
    await expect(drivePrePush(ctx)).rejects.toBeInstanceOf(DecisionNeeded);
    expect(ctx.state.status).not.toBe("finished");
    expect(ctx.state.stage).toBe("find");
  });
});

describe("a later round", () => {
  it("asks a person when another branch is checked out instead of reviewing it", async () => {
    const { execFileSync } = await import("node:child_process");
    const { startRound } = await import("../../src/state/prepush.js");
    const { ctx, repo } = await makeRun();
    const tipRef = ctx.eng.tipRef;
    expect(tipRef).toBeTruthy();
    ctx.state.round = 1;
    ctx.eng.roundOpen = false;
    execFileSync("git", ["checkout", "-q", "-b", "SYNTHETIC-other"], { cwd: repo });
    await expect(startRound(ctx)).rejects.toMatchObject({
      decision: expect.objectContaining({
        kind: "push_blocked",
        message: expect.stringContaining(`but SYNTHETIC-other is checked out`),
      }),
    });
    expect(ctx.state.round).toBe(1);
    execFileSync("git", ["checkout", "-q", tipRef as string], { cwd: repo });
    await startRound(ctx);
    expect(ctx.state.round).toBe(2);
  });
});

describe("working-tree inclusion", () => {
  it("follows range resolution, not the request flag", async () => {
    const { execFileSync } = await import("node:child_process");
    const { appendFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { buildSampleRepo } = await import("./scenario.js");
    const { computeGroups, reviewsWorktree } = await import("../../src/state/steps.js");
    const repo = buildSampleRepo();
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    appendFileSync(join(repo, "lint.py"), "\n# uncommitted\n");
    const { ctx } = await makeRun({
      repo,
      request: { tip: sha, readOnly: true, includeWorktree: true, base: "origin/main" },
    });
    ctx.state.round = 1;
    expect(ctx.eng.includeWorktree).toBe(false);
    expect(reviewsWorktree(ctx)).toBe(false);
    const files = (await computeGroups(ctx)).flatMap((g) => g.files);
    expect(files).not.toContain("lint.py");
  });

  it("reviews untracked files too, from one snapshot per round", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { vi } = await import("vitest");
    const { buildSampleRepo } = await import("./scenario.js");
    const { computeGroups, readOnlyRepo, reviewsWorktree } =
      await import("../../src/state/steps.js");
    const repo = buildSampleRepo();
    writeFileSync(join(repo, "SYNTHETIC_untracked.py"), "def f():\n    return 1\n");
    const { ctx } = await makeRun({ repo, request: { includeWorktree: true } });
    ctx.state.round = 1;
    expect(reviewsWorktree(ctx)).toBe(true);
    const snapshots = vi.spyOn(ctx.git, "snapshotWorktree");
    ctx.state.stage = "find";
    const groups = await computeGroups(ctx);
    const files = groups.flatMap((g) => g.files);
    expect(files).toContain("SYNTHETIC_untracked.py");
    expect(groups.flatMap((g) => g.hunks).some((h) => h.file === "SYNTHETIC_untracked.py")).toBe(
      true,
    );
    const first = await readOnlyRepo(ctx);
    ctx.state.stage = "verify";
    expect(await readOnlyRepo(ctx)).toBe(first);
    ctx.state.stage = "sweep";
    await computeGroups(ctx);
    expect(snapshots).toHaveBeenCalledTimes(1);
  });
});
