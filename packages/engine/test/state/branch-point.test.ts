import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRun } from "./harness.js";
import { Scenario, buildSampleRepo } from "./scenario.js";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/** Advances the named base independently from the feature branch. */
function movedBaseRepo(): string {
  const repo = buildSampleRepo();
  const branchPricing = readFileSync(join(repo, "shop/pricing.py"), "utf8");
  git(repo, "checkout", "-qb", "advanced-main", "origin/main");
  // The named base independently gains the branch-added bug and fixes the
  // older bug. Both labels differ from a comparison with the branch point.
  writeFileSync(
    join(repo, "shop/pricing.py"),
    branchPricing.replace("return int(amount * 100) / 100", "return round(amount, 2)"),
  );
  git(repo, "add", "shop/pricing.py");
  git(repo, "commit", "-qm", "Advance the named base independently");
  git(repo, "checkout", "-q", "feature");
  return repo;
}

function selectedScenario(ids: string[]): Scenario {
  const scenario = new Scenario();
  const selected = scenario.bugs.filter((bug) => ids.includes(bug.id));
  scenario.bugs.splice(0, scenario.bugs.length, ...selected);
  return scenario;
}

describe("verification against the branch point", () => {
  it("labels branch-added and older bugs independently of changes on the named base", async () => {
    const repo = movedBaseRepo();
    const scenario = selectedScenario(["B1", "B7"]);
    const { run } = await makeRun({
      repo,
      adapters: scenario.adapters(),
      request: { base: "advanced-main", readOnly: true, roundCap: 1 },
    });
    await run.start();
    const state = await run.settled();
    expect(state.error).toBeUndefined();
    const added = run.findings.find((finding) => finding.title.startsWith("average_price"));
    const older = run.findings.find((finding) => finding.title.startsWith("round_currency"));
    expect(added).toMatchObject({ verdict: "confirmed", introduced: true, verification: "script" });
    expect(older).toMatchObject({
      verdict: "confirmed",
      introduced: false,
      verification: "script",
    });
  });

  it("keeps a round-one branch-added bug introduced when a standard round reviews only the fix", async () => {
    const repo = movedBaseRepo();
    const scenario = selectedScenario(["B1", "B3"]);
    const later = scenario.bugs.find((bug) => bug.id === "B1")!;
    later.foundBy = [{ vendor: "any", round: 2, via: "review" }];
    const first = scenario.bugs.find((bug) => bug.id === "B3")!;
    first.foundBy = [{ vendor: "any", round: 1, via: "review" }];
    const { run } = await makeRun({
      repo,
      adapters: scenario.adapters(),
      request: { base: "advanced-main", depth: "standard", roundCap: 3 },
    });
    await run.start();
    const state = await run.settled();
    expect(state.error).toBeUndefined();
    const finding = run.findings.find((item) => item.title.startsWith("average_price"));
    expect(finding).toMatchObject({
      round: 2,
      verdict: "fixed",
      introduced: true,
      verification: "script",
    });
    expect(finding?.fixCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(
      scenario.calls.some(
        (call) => call.method === "review" && call.prompt.includes("only what the fixer changed"),
      ),
    ).toBe(true);
  });
});
