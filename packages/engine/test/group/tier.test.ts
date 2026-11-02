import { describe, expect, it } from "vitest";
import { fileTier, groupTier, nextTier, roleTier, type FileSignals } from "../../src/group/tier.js";

function signals(patch: Partial<FileSignals>): FileSignals {
  return {
    path: "src/a.ts",
    noCode: false,
    fileLines: 30,
    changedLines: 3,
    references: null,
    referencesSkipped: false,
    exportedChange: false,
    schemaPath: false,
    risky: null,
    riskPath: false,
    pinned: null,
    ...patch,
  };
}

describe("fileTier", () => {
  it.each<[string, Partial<FileSignals>, string, RegExp]>([
    ["30-line file, 3 changed lines", { fileLines: 30 }, "medium", /changes code/],
    ["300-line file, 3 changed lines", { fileLines: 300 }, "medium", /300 lines/],
    ["60 changed lines", { changedLines: 60 }, "medium", /60 changed/],
    ["300-line doc", { noCode: true, fileLines: 300 }, "small", /only docs/],
    ["doc on a risk path", { noCode: true, riskPath: true }, "large", /risk path/],
    ["2 references", { references: { symbol: "doWork", files: 2 } }, "medium", /changes code/],
    ["3 references", { references: { symbol: "doWork", files: 3 } }, "medium", /in 3 other/],
    ["9 references", { references: { symbol: "doWork", files: 9 } }, "medium", /in 9 other/],
    ["10 references", { references: { symbol: "doWork", files: 10 } }, "large", /in 10 other/],
    ["exported API", { exportedChange: true }, "large", /exported/],
    ["schema", { schemaPath: true }, "large", /schema/],
    ["concurrency", { risky: "concurrency" }, "large", /concurrency/],
    ["time limit", { referencesSkipped: true }, "medium", /ran out of time/],
    ["policy pin", { pinned: "small", riskPath: true }, "small", /tierPaths/],
  ])("%s", (_name, patch, tier, reason) => {
    const got = fileTier(signals(patch));
    expect(got.tier).toBe(tier);
    expect(got.reason).toMatch(reason);
  });
});

describe("groupTier", () => {
  it("takes the strongest file, whatever the order", () => {
    const docs = signals({ path: "a.md", noCode: true });
    const risky = signals({ path: "b.ts", risky: "parsing" });
    expect(groupTier([docs, risky], "auto").tier).toBe("large");
    expect(groupTier([risky, docs], "auto")).toEqual(groupTier([docs, risky], "auto"));
  });

  it("uses a fixed tier", () => {
    expect(groupTier([signals({ riskPath: true })], "small").tier).toBe("small");
  });
});

describe("roleTier", () => {
  const small = { tier: "small" as const, reason: "r" };
  const medium = { tier: "medium" as const, reason: "r" };
  const large = { tier: "large" as const, reason: "r" };
  it.each([
    ["reviewer", small, false, "small"],
    ["disprover", small, false, "medium"],
    ["disprover", medium, false, "large"],
    ["confirmer", large, false, "large"],
    ["fixer", small, false, "medium"],
    ["fixer", large, false, "large"],
    ["sweeper", large, false, "medium"],
    ["reviewer", small, true, "medium"],
    ["fixer", small, true, "large"],
    ["reviewer", null, false, "medium"],
  ] as const)("auto: %s from %j, persisting %s gives %s", (role, base, persisting, tier) => {
    expect(roleTier(base, role, { choice: "auto", persisting }).tier).toBe(tier);
  });

  it.each([
    ["reviewer", "small", "small"],
    ["disprover", "small", "medium"],
    ["fixer", "small", "medium"],
    ["disprover", "medium", "medium"],
    ["reviewer", "large", "large"],
  ] as const)("fixed: %s at %s gives %s", (role, choice, tier) => {
    expect(roleTier(large, role, { choice, persisting: true }).tier).toBe(tier);
  });

  it("stops at large", () => {
    expect(nextTier("large")).toBe("large");
  });
});
