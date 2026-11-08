import { describe, expect, it } from "vitest";
import { sweepPrompt } from "../../src/prompts/templates.js";

describe("sweepPrompt", () => {
  it("lists the changed files and the diff file in place of a large diff", () => {
    const prompt = sweepPrompt({
      range: { baseSha: "a".repeat(40), tipSha: "b".repeat(40), repoPath: "/work/repo" } as never,
      patterns: [],
      diff: "",
      changedFiles: ["src/a.ts", "src/b.ts"],
      diffFile: "/work/run/rounds/1/sweep.diff",
      policySection: "",
    });
    expect(prompt).toContain("## Changed files");
    expect(prompt).toContain("Read it from the file `/work/run/rounds/1/sweep.diff`");
    expect(prompt).not.toContain("git -C");
    expect(prompt).toContain("- src/b.ts");
    expect(prompt).not.toContain("## Diff");
  });
});
