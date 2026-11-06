import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTokenHistory, saveTokenSample } from "../../src/run/token-history.js";

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
    JSON.stringify([
      { id: "G01", changedLines: 40, files: ["a.ts", "b.ts"] },
      { id: "G02", changedLines: 60, files: ["c.ts"] },
    ]),
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
        lines: 100,
        files: 3,
        review: [
          {
            vendor: "claude",
            tier: "large",
            tokens: 313,
            groups: 2,
            lines: 100,
            points: [
              [40, 112],
              [60, 201],
            ],
          },
        ],
        verificationTokens: 72,
        fixingTokens: 51,
      },
    ]);
  });

  it("stores each finished run's sample and reads it back", async () => {
    const root = mkdtempSync(join(tmpdir(), "aio-token-history-"));
    writeRun(root, "01A", "finished");
    writeRun(root, "01B", "cancelled");
    const file = (id: string) => join(root, ".aio", "runs", id, "token-sample.json");
    const [first] = await loadTokenHistory(root);
    expect(existsSync(file("01B"))).toBe(false);
    const stored = JSON.parse(readFileSync(file("01A"), "utf8")) as unknown;
    expect(stored).toEqual(first);
    // The stored sample wins over the calls, which a finished run never changes.
    writeFileSync(file("01A"), JSON.stringify({ ...first, fixingTokens: 7 }));
    expect((await loadTokenHistory(root))[0]?.fixingTokens).toBe(7);
    await expect(saveTokenSample(root, "01B")).resolves.toBeNull();
    expect((await saveTokenSample(root, "01A"))?.fixingTokens).toBe(51);
  });

  it("returns nothing for a project with no runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "aio-token-history-"));
    await expect(loadTokenHistory(root)).resolves.toEqual([]);
  });
});

describe("usage windows", () => {
  it("records tokens by kind and the window share per weighted token, skipping a reset", async () => {
    const root = mkdtempSync(join(tmpdir(), "aio-token-history-"));
    const dir = join(root, ".aio", "runs", "01C");
    writeRun(root, "01C", "finished");
    const calls = join(dir, "rounds", "1", "calls");
    // Weighted: 1,000 + 9,000 * 0.1 + 20 * 5 = 2,000 per call.
    const tokens = { in: 10_000, out: 20, fresh: 1_000, cacheWrite: 0, cacheRead: 9_000 };
    for (const name of [
      "find-G01-claude.json",
      "find-G01-claude-ledger1.json",
      "find-G02-claude.json",
      "verify-G01.json",
      "sweep.json",
      "fix-G01.json",
    ])
      writeFileSync(
        join(calls, name),
        JSON.stringify({ vendor: "claude", tokens, tier: { tier: "large", reason: "test" } }),
      );
    const finished = { type: "agent.finished", vendor: "claude", tokens };
    const reading = (utilization: number, resetAt: string, minute: number) => ({
      type: "usage.sample",
      vendor: "claude",
      account: "user@example.com",
      window: "5h",
      utilization,
      spendUsd: null,
      resetAt,
      time: `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`,
    });
    const first = "2026-01-01T04:00:00.000Z";
    const second = "2026-01-01T09:00:00.000Z";
    const events = [
      finished,
      reading(0.1, first, 1),
      finished,
      reading(0.12, first, 2),
      finished,
      reading(0.15, first, 3),
      // The window resets: this stretch is unknown, so it is left out.
      finished,
      reading(0.01, second, 4),
      finished,
      reading(0.03, second, 5),
    ];
    writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
    const sample = await saveTokenSample(root, "01C");
    const [usage] = sample?.usage ?? [];
    expect(usage).toMatchObject({
      vendor: "claude",
      fresh: 6_000,
      cacheRead: 54_000,
      out: 120,
      raw: 60_120,
    });
    const [window] = usage?.windows ?? [];
    expect(window).toMatchObject({ window: "5h", weighted: 6_000, resets: 1, durationMs: 180_000 });
    expect(window?.used).toBeCloseTo(0.07);
    expect(window?.rate).toBeCloseTo(0.07 / 6_000);
  });

  it("leaves out a window when a call has no breakdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "aio-token-history-"));
    const dir = join(root, ".aio", "runs", "01D");
    writeRun(root, "01D", "finished");
    const tokens = { in: 10_000, out: 20, fresh: 1_000, cacheWrite: 0, cacheRead: 9_000 };
    writeFileSync(
      join(dir, "rounds", "1", "calls", "sweep.json"),
      JSON.stringify({ vendor: "claude", tokens }),
    );
    const reading = (u: number) => ({
      type: "usage.sample",
      vendor: "claude",
      account: "a",
      window: "5h",
      utilization: u,
      spendUsd: null,
      resetAt: null,
      time: "2026-01-01T00:00:00.000Z",
    });
    const events = [
      { type: "agent.finished", vendor: "claude", tokens },
      reading(0.1),
      { type: "agent.finished", vendor: "claude", tokens: { in: 5, out: 5 } },
      reading(0.2),
    ];
    writeFileSync(join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"));
    const sample = await saveTokenSample(root, "01D");
    expect(sample?.usage?.[0]?.windows).toEqual([]);
  });
});
