import { describe, expect, it } from "vitest";
import {
  RunTokenSampleSchema,
  STARTING_WINDOW_RATE,
  describeWindowShare,
  estimateRunTokens,
  estimateWindowShare,
  weightedTokens,
  type RunTokenSample,
} from "../src/index.js";

/** A synthetic finished run whose Claude calls used `used` of the 5-hour window. */
function sample(runId: string, used: number, weighted: number): RunTokenSample {
  return {
    runId,
    depth: "standard",
    scope: "range",
    effort: "default",
    readOnly: true,
    groups: 2,
    lines: 200,
    files: 4,
    review: [{ vendor: "claude", tier: "medium", tokens: 1_000_000, groups: 2, lines: 200 }],
    verificationTokens: 0,
    fixingTokens: 0,
    usage: [
      {
        vendor: "claude",
        // Weighted: 100,000 + 900,000 * 0.1 + 2,000 * 5 = 200,000.
        fresh: 100_000,
        cacheWrite: 0,
        cacheRead: 900_000,
        out: 2_000,
        raw: 1_002_000,
        windows: [
          { window: "5h", used, weighted, rate: used / weighted, durationMs: 60_000, resets: 0 },
        ],
      },
    ],
  };
}

describe("weightedTokens", () => {
  it("counts a cache read at a tenth of fresh input and output at five times", () => {
    expect(weightedTokens("claude", { fresh: 10, cacheWrite: 4, cacheRead: 100, out: 2 })).toBe(
      10 + 5 + 10 + 10,
    );
  });
});

describe("estimateWindowShare", () => {
  const byVendor = [
    { vendor: "claude" as const, tokens: 1_002_000, low: 1_002_000, high: 1_002_000 },
  ];

  it("uses the starting rate with a rough label when no run measured the window", () => {
    const [line] = estimateWindowShare(byVendor, [], []);
    expect(line).toMatchObject({ vendor: "claude", window: "5h", measured: false });
    expect(line?.low).toBeCloseTo(1_002_000 * STARTING_WINDOW_RATE.perRawToken * 0.25);
    expect(line?.source).toMatch(/rough, no measurements yet/);
  });

  it("gives no line for a vendor with neither a measurement nor a starting rate", () => {
    expect(estimateWindowShare([{ vendor: "codex", tokens: 1, low: 1, high: 1 }], [], [])).toEqual(
      [],
    );
  });

  it("fits a rate per weighted token from finished runs", () => {
    // Both runs used 0.1 of the window per 200,000 weighted tokens.
    const history = [sample("01A", 0.1, 200_000), sample("01B", 0.1, 200_000)];
    const [line] = estimateWindowShare(byVendor, history, []);
    expect(line).toMatchObject({ vendor: "claude", window: "5h", measured: true });
    // The same run again: 200,000 weighted tokens, so 0.1 of the window.
    expect(line?.low).toBeCloseTo(0.1 * 0.8);
    expect(line?.high).toBeCloseTo(0.1 * 1.25);
    expect(line?.source).toMatch(/2 runs in this project.*errs high/);
  });

  it("widens the range when measured runs disagree", () => {
    const history = [sample("01A", 0.05, 200_000), sample("01B", 0.2, 200_000)];
    const [line] = estimateWindowShare(byVendor, history, []);
    expect(line!.high / line!.low).toBeGreaterThan(3);
  });

  it("loads a sample saved before the breakdown existed", () => {
    const { usage: _usage, ...older } = sample("01A", 0.1, 1);
    expect(RunTokenSampleSchema.parse(older).usage).toBeUndefined();
  });
});

describe("estimateRunTokens windows", () => {
  it("splits the estimate by vendor and adds a window line", () => {
    const estimate = estimateRunTokens({
      depth: "standard",
      reviewers: ["claude", "codex"],
      groups: [{ changedLines: 10 }, { changedLines: 10 }],
    });
    expect(estimate.byVendor.map((v) => v.vendor)).toEqual(["claude", "codex"]);
    const total = estimate.byVendor.reduce((n, v) => n + v.tokens, 0);
    expect(total / estimate.tokens).toBeCloseTo(1, 1);
    expect(estimate.windows.map((w) => `${w.vendor}/${w.window}`)).toEqual(["claude/5h"]);
  });
});

describe("describeWindowShare", () => {
  const line = { vendor: "claude" as const, window: "5h" as const, measured: true };
  it("phrases a share as a percent range", () => {
    expect(describeWindowShare({ ...line, low: 0.152, high: 0.248 })).toBe(
      "about 15 to 25% of your 5-hour Claude window",
    );
    expect(describeWindowShare({ ...line, low: 0.004, high: 0.006 })).toBe(
      "under 1% of your 5-hour Claude window",
    );
    expect(describeWindowShare({ ...line, low: 0.6, high: 1.4 })).toBe(
      "from 60% to more than all of your 5-hour Claude window",
    );
    expect(describeWindowShare({ ...line, low: 1.2, high: 2, measured: false })).toBe(
      "more than all of your 5-hour Claude window (rough, no measurements yet)",
    );
  });
});
