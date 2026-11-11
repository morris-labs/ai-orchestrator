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

describe("sweepPromptFits", () => {
  it("moves a token-dense diff out of the prompt before it fills a 128,000-token window", async () => {
    const { sweepPromptFits } = await import("../../src/state/steps.js");
    // About 140,000 tokens at four characters each, but nearer 190,000 at three.
    expect(sweepPromptFits("x".repeat(560_000))).toBe(false);
    expect(sweepPromptFits("x".repeat(200_000))).toBe(true);
  });
});

describe("strictTokenCount", () => {
  it("counts a CJK diff at more than one token per two characters (F-0129)", async () => {
    const { strictTokenCount, sweepPromptFits } = await import("../../src/state/steps.js");
    // 3 UTF-8 bytes each, so 1.5 tokens per character.
    expect(strictTokenCount("一".repeat(200_000))).toBe(300_000);
    expect(sweepPromptFits("一".repeat(200_000))).toBe(false);
    expect(strictTokenCount("x".repeat(250))).toBe(100);
  });
});

describe("fitSweepFallback", () => {
  const range = { baseSha: "a".repeat(40), tipSha: "b".repeat(40), repoPath: "/work/repo" };
  const pattern = (i: number, failureCase: string) =>
    ({ id: `F-${i}`, title: `Pattern ${i}`, file: "src/a.ts", failureCase }) as never;

  it("drops the policy and then patterns until the prompt without the diff fits (F-0129)", async () => {
    const { fitSweepFallback, sweepPromptFits } = await import("../../src/state/steps.js");
    const big = "y".repeat(150_000);
    const fitted = fitSweepFallback({
      range: range as never,
      patterns: [pattern(1, "short"), pattern(2, big), pattern(3, big)],
      diff: "",
      changedFiles: ["src/a.ts"],
      diffFile: "/work/run/rounds/1/sweep.diff",
      policySection: "z".repeat(200_000),
    });
    expect(fitted?.patterns).toBe(2);
    expect(sweepPromptFits(fitted?.prompt ?? "")).toBe(true);
    expect(fitted?.prompt).not.toContain("zzz");
  });

  it("gives null when not even one pattern fits", async () => {
    const { fitSweepFallback } = await import("../../src/state/steps.js");
    expect(
      fitSweepFallback({
        range: range as never,
        patterns: [pattern(1, "y".repeat(400_000))],
        diff: "",
        changedFiles: ["src/a.ts"],
        diffFile: "/work/run/rounds/1/sweep.diff",
        policySection: "",
      }),
    ).toBeNull();
  });
});
