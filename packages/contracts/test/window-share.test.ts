import { describe, expect, it } from "vitest";
import {
  RunTokenSampleSchema,
  STARTING_VERIFICATION_SPLIT,
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

  it("treats a window that didn't move a step as unmeasured (F-0017)", () => {
    const [line] = estimateWindowShare(byVendor, [sample("01A", 0, 200_000)], []);
    expect(line).toMatchObject({ vendor: "claude", window: "5h", measured: false });
    expect(line?.high).toBeGreaterThan(0);
  });

  it("pools only rates of the account this project's newest run used (F-0061)", () => {
    const keyed = (runId: string, used: number, account: string): RunTokenSample => {
      const s = sample(runId, used, 200_000);
      const [usage] = s.usage!;
      return {
        ...s,
        usage: [{ ...usage!, windows: usage!.windows!.map((w) => ({ ...w, account })) }],
      };
    };
    // A small plan in this project, a plan ten times larger in another.
    const [line] = estimateWindowShare(
      byVendor,
      [keyed("01B", 0.1, "small")],
      [keyed("01C", 0.01, "large"), keyed("01A", 0.1, "small")],
    );
    expect(line).toMatchObject({ measured: true });
    expect(line?.low).toBeCloseTo(0.1 * 0.8);
    expect(line?.source).toMatch(/1 run in this project and 1 run/);
  });

  it("takes no measured rate from another project alone (F-0061)", () => {
    const [line] = estimateWindowShare(byVendor, [], [sample("01A", 0.01, 200_000)]);
    expect(line).toMatchObject({ vendor: "claude", window: "5h", measured: false });
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

describe("estimateRunTokens stage vendors", () => {
  const stageTokens = (e: ReturnType<typeof estimateRunTokens>) =>
    e.lines
      .filter((l) => l.label === "Verification" || l.label === "Fixing")
      .reduce((n, l) => n + l.tokens, 0);

  it("gives no stage tokens to a vendor on the older rate (F-0016)", () => {
    const estimate = estimateRunTokens({
      depth: "standard",
      reviewers: ["claude", "codex"],
      groups: [{ changedLines: 10 }, { changedLines: 10 }],
    });
    const review = estimate.lines.find((l) => l.label === "Review")!.tokens;
    const older = estimate.lines.find((l) => l.label === "Whole run, no measurements")!.tokens;
    const by = Object.fromEntries(estimate.byVendor.map((v) => [v.vendor, v.tokens]));
    expect(by.codex).toBe(older);
    expect(by.claude! / (review + stageTokens(estimate))).toBeCloseTo(1, 1);
  });

  it("charges verification to the verifier and fixing to the fixer (F-0022)", () => {
    const estimate = estimateRunTokens({
      depth: "standard",
      reviewers: ["claude"],
      verifiers: { claude: "codex" },
      fixer: "claude",
      groups: [{ changedLines: 10 }],
    });
    const verification = estimate.lines.find((l) => l.label === "Verification")!.tokens;
    const by = Object.fromEntries(estimate.byVendor.map((v) => [v.vendor, v.tokens]));
    expect(by.codex! / verification).toBeCloseTo(1, 1);
    expect((by.claude! + by.codex!) / estimate.tokens).toBeCloseTo(1, 1);
  });

  it("charges confirmer and sweep tokens to their own vendors (F-0059)", () => {
    const history: RunTokenSample[] = ["01A", "01B", "01C"].map((runId) => ({
      runId,
      depth: "standard",
      scope: "range",
      effort: "default",
      readOnly: false,
      groups: 1,
      lines: 10,
      files: 1,
      review: [{ vendor: "claude", tier: null, tokens: 100_000, groups: 1, lines: 10 }],
      verificationTokens: 40_000,
      verificationStages: { disprove: 20_000, confirm: 10_000, sweep: 10_000 },
      fixingTokens: 0,
    }));
    const estimate = estimateRunTokens({
      depth: "standard",
      reviewers: ["claude"],
      verifiers: { claude: "codex" },
      confirmer: "claude",
      sweeper: "copilot",
      fixer: "claude",
      groups: [{ changedLines: 10 }],
      history,
    });
    const verification = estimate.lines.find((l) => l.label === "Verification")!.tokens;
    const fixing = estimate.lines.find((l) => l.label === "Fixing")!.tokens;
    const review = estimate.lines.find((l) => l.label === "Review")!.tokens;
    const by = Object.fromEntries(estimate.byVendor.map((v) => [v.vendor, v.tokens]));
    expect(by.codex! / (verification / 2)).toBeCloseTo(1, 1);
    expect(by.copilot! / (verification / 4)).toBeCloseTo(1, 1);
    expect(by.claude! / (review + fixing + verification / 4)).toBeCloseTo(1, 1);
  });

  it("charges confirmer and sweep tokens to their vendors without a measured split (F-0059)", () => {
    const estimate = estimateRunTokens({
      depth: "standard",
      reviewers: ["claude"],
      verifiers: { claude: "codex" },
      confirmer: "claude",
      fixer: "claude",
      groups: [{ changedLines: 10 }],
    });
    const verification = estimate.lines.find((l) => l.label === "Verification")!.tokens;
    const by = Object.fromEntries(estimate.byVendor.map((v) => [v.vendor, v.tokens]));
    // Without a sweeper, the disprover's vendor runs the sweep.
    const { disprove, sweep } = STARTING_VERIFICATION_SPLIT;
    expect(by.codex! / (verification * (disprove + sweep))).toBeCloseTo(1, 1);
    expect((by.claude! + by.codex!) / estimate.tokens).toBeCloseTo(1, 1);
  });

  it("charges an older-rate group's verification and fixing to their vendors (F-0060)", () => {
    const estimate = estimateRunTokens({
      depth: "standard",
      reviewers: ["codex"],
      verifiers: { codex: "copilot" },
      fixer: "claude",
      groups: [{ changedLines: 0 }],
    });
    const older = estimate.lines.find((l) => l.label === "Whole run, no measurements")!.tokens;
    const by = Object.fromEntries(estimate.byVendor.map((v) => [v.vendor, v.tokens]));
    expect(by.copilot).toBeGreaterThan(0);
    expect(by.claude).toBeGreaterThan(0);
    expect(by.codex).toBeLessThan(older);
    expect((by.codex! + by.copilot! + by.claude!) / older).toBeCloseTo(1, 1);
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
