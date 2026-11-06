import { describe, expect, it } from "vitest";
import { sweepPrompt } from "../../src/prompts/templates.js";

describe("sweepPrompt", () => {
  it("lists the changed files and a Git command in place of a large diff", () => {
    const prompt = sweepPrompt({
      range: { baseSha: "a".repeat(40), tipSha: "b".repeat(40), repoPath: "/work/repo" } as never,
      patterns: [],
      diff: "",
      changedFiles: ["src/a.ts", "src/b.ts"],
      policySection: "",
    });
    expect(prompt).toContain("## Changed files");
    expect(prompt).toContain(`git -C /work/repo diff ${"a".repeat(40)} ${"b".repeat(40)} -- FILE`);
    expect(prompt).toContain("- src/b.ts");
    expect(prompt).not.toContain("## Diff");
  });
});
