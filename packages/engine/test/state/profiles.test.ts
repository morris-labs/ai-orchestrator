import type { FileGroup } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import { assignRoles, planReviews, profileRoles } from "../../src/state/profiles.js";

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
