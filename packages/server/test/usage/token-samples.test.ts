import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readHostTokenSamples } from "../../src/usage/token-samples.js";

const sample = (runId: string) => ({
  runId,
  depth: "standard",
  scope: "whole",
  effort: "default",
  readOnly: true,
  groups: 2,
  lines: 100,
  files: 3,
  review: [{ vendor: "claude", tier: "medium", tokens: 300, groups: 2, lines: 100 }],
  verificationTokens: 50,
  fixingTokens: 0,
});

function project(runs: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "aio-token-samples-"));
  for (const [id, content] of Object.entries(runs)) {
    const dir = join(root, ".aio", "runs", id);
    mkdirSync(dir, { recursive: true });
    if (content) writeFileSync(join(dir, "token-sample.json"), content);
  }
  return root;
}

describe("readHostTokenSamples", () => {
  it("reads other projects' samples, newest first, and skips the asking project", async () => {
    const own = project({ "01C": JSON.stringify(sample("01C")) });
    const other = project({
      "01A": JSON.stringify(sample("01A")),
      "01B": JSON.stringify(sample("01B")),
    });
    const third = project({ "01D": JSON.stringify(sample("01D")) });
    const samples = await readHostTokenSamples([own, other, third], own);
    expect(samples.map((s) => s.runId)).toEqual(["01D", "01B", "01A"]);
  });

  it("skips damaged files, foreign run ids, links, and runs with no sample", async () => {
    const outside = mkdtempSync(join(tmpdir(), "aio-token-samples-"));
    writeFileSync(join(outside, "target.json"), JSON.stringify(sample("01L")));
    const root = project({
      "01A": "{",
      "01B": JSON.stringify(sample("01X")),
      "01C": JSON.stringify({ ...sample("01C"), groups: -1 }),
      "01D": "",
      "01L": "",
    });
    symlinkSync(
      join(outside, "target.json"),
      join(root, ".aio", "runs", "01L", "token-sample.json"),
    );
    await expect(readHostTokenSamples([root], "")).resolves.toEqual([]);
  });

  it("returns nothing for a root with no runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "aio-token-samples-"));
    await expect(readHostTokenSamples([root, join(root, "missing")], "")).resolves.toEqual([]);
  });
});
