import { describe, expect, it } from "vitest";
import { SWEEP_CHANGED_FILES_LIMIT, sweepPrompt } from "../../src/prompts/templates.js";

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

  it("caps the changed-file list", () => {
    const files = Array.from({ length: SWEEP_CHANGED_FILES_LIMIT + 25 }, (_, i) => `src/f${i}.ts`);
    const prompt = sweepPrompt({
      range: { baseSha: "a".repeat(40), tipSha: "b".repeat(40), repoPath: "/work/repo" } as never,
      patterns: [],
      diff: "",
      changedFiles: files,
      diffFile: "/work/run/rounds/1/sweep.diff",
      policySection: "",
    });
    expect(prompt).toContain(`- src/f${SWEEP_CHANGED_FILES_LIMIT - 1}.ts`);
    expect(prompt).not.toContain(`- src/f${SWEEP_CHANGED_FILES_LIMIT}.ts`);
    expect(prompt).toContain("...and 25 more files.");
  });
});
