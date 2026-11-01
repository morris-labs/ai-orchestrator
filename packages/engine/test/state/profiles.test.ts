import type { FileGroup } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { assignRoles, planReviews, profileRoles } from "../../src/state/profiles.js";
import { runPerVendor } from "../../src/state/steps.js";

const all = ["claude", "codex", "copilot"] as const;

function group(id: string, kind: "major" | "minor"): FileGroup {
  return { id, files: [`${id}.py`], kind, changedLines: 10, riskPath: false, hunks: [] };
}

describe("profiles", () => {
  it("keeps Claude to fixing in offload and reviewing early in balanced", () => {
    expect(profileRoles("offload", 1)).toEqual({
      reviewer: ["codex", "copilot"],
      disprover: "codex",
      confirmer: "codex",
      fixer: "claude",
    });
    expect(profileRoles("balanced", 2).reviewer).toContain("claude");
    expect(profileRoles("balanced", 3).reviewer).not.toContain("claude");
    expect(profileRoles("fast", 9)).toMatchObject({
      reviewer: ["claude", "codex"],
      disprover: "claude",
    });
  });

  it("applies availability, manual roles, alternation, and a confirmer other than the fixer", () => {
    expect(
      assignRoles({
        profile: "offload",
        round: 1,
        available: ["claude", "codex"],
        crossVendor: true,
      }).reviewer,
    ).toEqual(["codex"]);
    const manual = assignRoles({
      profile: "offload",
      round: 1,
      available: all,
      crossVendor: true,
      manual: { disprover: "claude", reviewer: ["copilot"] },
    });
    expect(manual).toMatchObject({ reviewer: ["copilot"], disprover: "claude" });
    expect(
      assignRoles({
        profile: "offload",
        round: 3,
        available: all,
        crossVendor: true,
        alternating: true,
      }).reviewer,
    ).toEqual(["codex"]);
    expect(
      assignRoles({
        profile: "offload",
        round: 4,
        available: all,
        crossVendor: true,
        alternating: true,
      }).reviewer,
    ).toEqual(["copilot"]);
    expect(
      assignRoles({
        profile: "offload",
        round: 1,
        available: all,
        crossVendor: true,
        manual: { confirmer: "claude" },
      }).confirmer,
    ).toBe("codex");
    expect(
      assignRoles({ profile: "offload", round: 1, available: ["claude"], crossVendor: true }),
    ).toMatchObject({
      reviewer: ["claude"],
      disprover: "claude",
      confirmer: "claude",
    });
  });

  it("plans no review of an empty diff", () => {
    expect(planReviews(["claude", "codex", "copilot"], [], "balanced")).toEqual([]);
  });

  it("plans a whole-diff Copilot review, two focused reviewers on major groups, and one on minor groups", () => {
    const groups = [group("G01", "major"), group("G02", "minor"), group("G03", "minor")];
    const offload = planReviews(["codex", "copilot"], groups, "offload");
    expect(offload.map((t) => t.key)).toEqual([
      "all-copilot",
      "G01-codex",
      "G02-codex",
      "G03-codex",
    ]);
    const balanced = planReviews(["claude", "codex", "copilot"], groups, "balanced");
    expect(balanced.map((t) => t.key)).toEqual([
      "all-copilot",
      "G01-claude",
      "G01-codex",
      "G02-codex",
      "G03-claude",
    ]);
    expect(balanced[1]?.focusAreas).not.toEqual(balanced[2]?.focusAreas);
    const fast = planReviews(["claude", "codex"], groups, "fast");
    expect(fast).toHaveLength(6);
  });
});

describe("runPerVendor", () => {
  it("caps the calls in flight per vendor and keeps the items' order", async () => {
    const items = [
      ...Array.from({ length: 5 }, (_, i) => ({ vendor: "claude" as const, i })),
      ...Array.from({ length: 3 }, (_, i) => ({ vendor: "codex" as const, i: 10 + i })),
    ];
    const inFlight = { claude: 0, codex: 0 };
    const peak = { claude: 0, codex: 0 };
    const out = await runPerVendor(items, 2, async (item) => {
      inFlight[item.vendor] += 1;
      peak[item.vendor] = Math.max(peak[item.vendor], inFlight[item.vendor]);
      await new Promise((r) => setTimeout(r, 5));
      inFlight[item.vendor] -= 1;
      return item.i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4, 10, 11, 12]);
    expect(peak).toEqual({ claude: 2, codex: 2 });
  });
});
