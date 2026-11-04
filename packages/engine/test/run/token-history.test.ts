import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTokenHistory } from "../../src/run/token-history.js";

function writeRun(root: string, id: string, status: string): void {
  const calls = join(root, ".aio", "runs", id, "rounds", "1", "calls");
  mkdirSync(calls, { recursive: true });
  writeFileSync(
    join(root, ".aio", "runs", id, "state.json"),
    JSON.stringify({
      status,
      request: { depth: "standard", scope: "whole", reviewerEffort: "high", readOnly: true },
    }),
  );
  writeFileSync(
    join(root, ".aio", "runs", id, "rounds", "1", "groups.json"),
    JSON.stringify([{ id: "G01" }, { id: "G02" }]),
  );
  const call = (tokens: number) =>
    JSON.stringify({
      vendor: "claude",
      tokens: { in: tokens, out: 1 },
      tier: { tier: "large", reason: "test" },
    });
  writeFileSync(join(calls, "find-G01-claude.json"), call(100));
  writeFileSync(join(calls, "find-G01-claude-ledger1.json"), call(10));
  writeFileSync(join(calls, "find-G02-claude.json"), call(200));
  writeFileSync(join(calls, "verify-G01.json"), call(30));
  writeFileSync(join(calls, "sweep.json"), call(40));
  writeFileSync(join(calls, "fix-G01.json"), call(50));
  writeFileSync(join(calls, "broken.json"), "{");
}

describe("loadTokenHistory", () => {
  it("adds up finished runs by stage, and skips other runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "aio-token-history-"));
    writeRun(root, "01A", "finished");
    writeRun(root, "01B", "cancelled");
    const samples = await loadTokenHistory(root);
    expect(samples).toEqual([
      {
        runId: "01A",
        depth: "standard",
        scope: "whole",
        effort: "high",
        readOnly: true,
        groups: 2,
        review: [{ vendor: "claude", tier: "large", tokens: 313, groups: 2 }],
        verificationTokens: 72,
        fixingTokens: 51,
      },
    ]);
  });

  it("returns nothing for a project with no runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "aio-token-history-"));
    await expect(loadTokenHistory(root)).resolves.toEqual([]);
  });
});
