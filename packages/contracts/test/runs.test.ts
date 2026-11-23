import { describe, expect, it } from "vitest";
import {
  EngineRunCreateSchema,
  FileGroupSchema,
  LeaseRequestFrameSchema,
  LeaseRequestSchema,
  LeaseResponseFrameSchema,
  LeaseResponseSchema,
  POST_PUSH_ROUND_CAP,
  READ_ONLY_POST_PUSH_MESSAGE,
  ResolvedRunRequestSchema,
  RoleOverridesSchema,
  RoundSummarySchema,
  RunRequestSchema,
  RunStateSchema,
  postPushRoundCap,
  estimateRunTokens,
  type RunTokenSample,
  profileRoles,
  runDepth,
  wantsCopilotReview,
} from "../src/index.js";
import {
  RUN,
  fileGroup,
  leaseRequest,
  leaseResponses,
  roundSummary,
  runRequest,
  runState,
} from "./fixtures.js";
import { roundTrip } from "./helpers.js";

describe("runs", () => {
  it("applies the design.md defaults to a run request", () => {
    const parsed = roundTrip(RunRequestSchema, { projectId: "p", repoPath: "/r" });
    expect(parsed).toEqual({
      projectId: "p",
      repoPath: "/r",
      base: "origin/main",
      mergeBase: true,
      exactBase: false,
      pipeline: "pre-push",
      profile: "offload",
      readOnly: false,
      includeWorktree: false,
      crossVendor: true,
      roundCap: 2,
      overlapThreshold: 0.5,
      continuationCap: 0,
      depth: "standard",
      verifyFloor: "P2",
      copilotReview: false,
    });
    expect(ResolvedRunRequestSchema.parse(parsed)).toEqual(parsed);
  });

  it("gives each depth its defaults, and lets a named setting win", () => {
    const thorough = RunRequestSchema.parse({ ...runRequest, depth: "thorough" });
    expect(thorough).toMatchObject({ roundCap: 25, continuationCap: 3 });
    expect(thorough.verifyFloor).toBeUndefined();
    const named = RunRequestSchema.parse({
      ...runRequest,
      roundCap: 7,
      continuationCap: 1,
      verifyFloor: "nit",
    });
    expect(named).toMatchObject({
      depth: "standard",
      roundCap: 7,
      continuationCap: 1,
      verifyFloor: "nit",
    });
    expect(RunRequestSchema.parse(named)).toEqual(named);
    expect(RunRequestSchema.parse({ ...runRequest, pipeline: "post-push" }).roundCap).toBe(25);
  });

  it("parses a stored request with no depth, and keeps it thorough", () => {
    const { depth: _depth, ...stored } = RunRequestSchema.parse({
      ...runRequest,
      depth: "thorough",
    });
    const parsed = ResolvedRunRequestSchema.parse(stored);
    expect(parsed.depth).toBeUndefined();
    expect(runDepth(parsed)).toBe("thorough");
  });

  describe("estimateRunTokens", () => {
    const groups = (n: number, tier: "medium" | "large" = "medium") =>
      Array.from({ length: n }, () => ({ tier, changedLines: 1000 }));
    const sample = (runId: string, perGroup: number): RunTokenSample => ({
      runId,
      depth: "standard",
      scope: "whole",
      effort: "high",
      readOnly: true,
      groups: 10,
      lines: 10_000,
      review: [
        { vendor: "claude", tier: "medium", tokens: perGroup * 10, groups: 10, lines: 10_000 },
      ],
      verificationTokens: 100_000,
      fixingTokens: 0,
    });

    it("uses starting rates by tier and effort, and leaves fixing out of read-only runs", () => {
      const input = { depth: "standard", scope: "whole", readOnly: true } as const;
      const medium = estimateRunTokens({ ...input, groups: groups(10) });
      const large = estimateRunTokens({ ...input, groups: groups(10, "large") });
      const high = estimateRunTokens({ ...input, groups: groups(10, "large"), effort: "high" });
      expect(medium.lines.map((l) => l.label)).toEqual(["Review", "Verification"]);
      expect(medium.lines[0]?.tokens).toBe(700_000);
      expect(large.lines[0]?.tokens).toBe(2_900_000);
      expect(high.lines[0]?.tokens).toBe(5_800_000);
      expect(medium.low).toBeLessThan(medium.tokens);
      expect(medium.high).toBeGreaterThan(medium.tokens);
      expect(medium.basis).toMatch(/starting rates/);
    });

    it("adds a fixing line when the run can fix", () => {
      const made = estimateRunTokens({ depth: "standard", scope: "whole", groups: groups(1) });
      expect(made.lines.map((l) => l.label)).toContain("Fixing");
    });

    it("prefers matching project runs and says how many", () => {
      const made = estimateRunTokens({
        depth: "standard",
        scope: "whole",
        effort: "high",
        readOnly: true,
        groups: groups(10),
        history: [sample("a", 100_000), sample("b", 200_000), sample("c", 300_000)],
      });
      // The newest run counts most: (0.64 * 100,000 + 0.8 * 200,000 + 300,000) / 2.44.
      expect(made.lines[0]?.tokens).toBe(2_100_000);
      expect(made.lines[0]?.low).toBe(800_000);
      expect(made.lines[0]?.high).toBe(3_700_000);
      expect(made.basis).toMatch(/based on 3 runs in this project/);
      expect(made.basis).not.toMatch(/other projects/);
    });

    it("weights history by each run's groups", () => {
      const small = { ...sample("a", 900_000), groups: 1 };
      small.review = [
        { vendor: "claude", tier: "medium", tokens: 900_000, groups: 1, lines: 1000 },
      ];
      const large = { ...sample("b", 100_000), groups: 99 };
      large.review = [
        { vendor: "claude", tier: "medium", tokens: 9_900_000, groups: 99, lines: 99_000 },
      ];
      const made = estimateRunTokens({
        depth: "standard",
        scope: "whole",
        effort: "high",
        readOnly: true,
        groups: groups(10),
        history: [small, large],
      });
      // 108,000 per group, rounded to two figures. Unweighted, it would be 5,000,000.
      expect(made.lines[0]?.tokens).toBe(1_100_000);
    });

    it("ignores runs with another scope or depth", () => {
      const made = estimateRunTokens({
        depth: "standard",
        scope: "whole",
        effort: "high",
        readOnly: true,
        groups: groups(10),
        history: [
          { ...sample("a", 900_000), scope: "range" },
          { ...sample("b", 900_000), depth: "thorough" },
        ],
        hostHistory: [{ ...sample("c", 900_000), scope: "range" }],
      });
      expect(made.lines[0]?.tokens).toBe(1_300_000);
      expect(made.basis).not.toMatch(/based on/);
    });

    it("moves a run at another effort by the starting ratio", () => {
      const made = estimateRunTokens({
        depth: "standard",
        scope: "whole",
        effort: "medium",
        readOnly: true,
        groups: groups(10),
        history: [sample("a", 130_000)],
      });
      // 130,000 at high is 70,000 at medium, by the starting rates.
      expect(made.lines[0]?.tokens).toBe(700_000);
      expect(made.lines[0]?.source).toMatch(/1 run in this project, adjusted .* starting ratio/);
    });

    it("moves a run at another effort by a measured ratio when one exists", () => {
      const at = (runId: string, effort: string, perGroup: number) => ({
        ...sample(runId, perGroup),
        effort,
      });
      const made = estimateRunTokens({
        depth: "standard",
        scope: "whole",
        effort: "default",
        readOnly: true,
        groups: groups(10),
        // This project ran at high only; another project measured both efforts.
        history: [at("c", "high", 300_000)],
        hostHistory: [at("a", "medium", 100_000), at("b", "high", 200_000)],
      });
      expect(made.lines[0]?.source).toMatch(/measured ratio/);
      expect(made.lines[0]?.tokens).toBeLessThan(2_000_000);
    });

    it("falls back to other projects' runs before the starting rates", () => {
      const made = estimateRunTokens({
        depth: "standard",
        scope: "whole",
        effort: "high",
        readOnly: true,
        groups: groups(10),
        hostHistory: [sample("a", 200_000), sample("b", 200_000)],
      });
      expect(made.lines[0]?.tokens).toBe(2_000_000);
      expect(made.basis).toMatch(/based on 2 runs in other projects/);
      expect(made.lines[1]?.source).toMatch(/2 runs in other projects/);
    });

    it("joins other projects' runs to one project run, and drops them at two", () => {
      const input = {
        depth: "standard",
        scope: "whole",
        effort: "high",
        readOnly: true,
        groups: groups(10),
        hostHistory: [sample("a", 400_000)],
      } as const;
      const one = estimateRunTokens({ ...input, history: [sample("b", 100_000)] });
      const two = estimateRunTokens({
        ...input,
        history: [sample("b", 100_000), sample("c", 100_000)],
      });
      // One project run at weight 1 and one other run at 0.5.
      expect(one.lines[0]?.tokens).toBe(2_000_000);
      expect(one.basis).toMatch(/1 run in this project and 1 run in other projects/);
      expect(two.lines[0]?.tokens).toBe(1_000_000);
      expect(two.basis).not.toMatch(/other projects/);
    });

    it("scales reviewer tokens with group size", () => {
      // 50,000 a group plus 100 a line, over groups of 100 to 1,000 lines.
      const points = Array.from({ length: 10 }, (_, i): [number, number] => [
        (i + 1) * 100,
        50_000 + (i + 1) * 100 * 100,
      ]);
      const measured: RunTokenSample = {
        ...sample("a", 0),
        lines: 5_500,
        review: [
          {
            vendor: "claude",
            tier: "medium",
            tokens: points.reduce((n, [, t]) => n + t, 0),
            groups: 10,
            lines: 5_500,
            points,
          },
        ],
      };
      const sized = (changedLines: number) =>
        estimateRunTokens({
          depth: "standard",
          scope: "whole",
          effort: "high",
          readOnly: true,
          groups: Array.from({ length: 10 }, () => ({ tier: "medium" as const, changedLines })),
          history: [measured],
        });
      expect(sized(500).lines[0]?.tokens).toBe(1_000_000);
      expect(sized(1500).lines[0]?.tokens).toBe(2_000_000);
      expect(sized(500).basis).toMatch(/5,000 changed lines/);
    });

    it("uses the prior rate per line when group sizes don't vary", () => {
      // Every group has 1,000 lines and 130,000 tokens: 30 a line, 100,000 a group.
      const made = estimateRunTokens({
        depth: "standard",
        scope: "whole",
        effort: "high",
        readOnly: true,
        groups: [{ tier: "medium", changedLines: 0 }],
        history: [
          {
            ...sample("a", 130_000),
            review: [
              { vendor: "claude", tier: "medium", tokens: 1_300_000, groups: 10, lines: 10_000 },
            ],
          },
        ],
      });
      expect(made.lines[0]?.tokens).toBe(100_000);
    });

    it("keeps the older rate for a vendor or depth with no data, and says so", () => {
      const codex = estimateRunTokens({
        depth: "standard",
        scope: "whole",
        reviewers: ["codex"],
        groups: groups(10),
      });
      const thorough = estimateRunTokens({ depth: "thorough", groups: groups(10) });
      expect(codex.tokens).toBe(5_800_000);
      expect(codex.lines).toHaveLength(1);
      expect(codex.basis).toMatch(/older rate/);
      expect(thorough.tokens).toBe(13_000_000);
    });

    it("splits groups in turn among reviewers", () => {
      const made = estimateRunTokens({
        depth: "standard",
        scope: "whole",
        readOnly: true,
        reviewers: ["claude", "codex"],
        groups: groups(2),
      });
      expect(made.lines.map((l) => l.label)).toEqual([
        "Review",
        "Whole run, no measurements",
        "Verification",
      ]);
    });
  });

  it("has no defaults on the resolved request", () => {
    expect(ResolvedRunRequestSchema.safeParse(runRequest).success).toBe(false);
  });

  it("turns off the merge base when exactBase is set", () => {
    expect(RunRequestSchema.parse({ ...runRequest, exactBase: true }).mergeBase).toBe(false);
  });

  it("requires the server-minted run id on the engine's create body", () => {
    expect(EngineRunCreateSchema.safeParse(runRequest).success).toBe(false);
    const parsed = EngineRunCreateSchema.parse({ ...runRequest, runId: RUN, exactBase: true });
    expect(parsed.runId).toBe(RUN);
    expect(parsed.mergeBase).toBe(false);
  });

  it("refuses a read-only request for the post-push pipeline", () => {
    const bad = { ...runRequest, readOnly: true, pipeline: "post-push" };
    const result = RunRequestSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(READ_ONLY_POST_PUSH_MESSAGE);
    expect(EngineRunCreateSchema.safeParse({ ...bad, runId: RUN }).success).toBe(false);
    expect(RunRequestSchema.safeParse({ ...runRequest, readOnly: true }).success).toBe(true);
    expect(RunRequestSchema.safeParse({ ...runRequest, pipeline: "post-push" }).success).toBe(true);
  });

  it("parses a request with and without starting roles", () => {
    expect(RunRequestSchema.parse(runRequest)).not.toHaveProperty("roles");
    const roles = { reviewer: ["codex"], confirmer: "copilot" };
    const parsed = roundTrip(RunRequestSchema, { ...runRequest, roles });
    expect(parsed.roles).toEqual(roles);
    expect(ResolvedRunRequestSchema.parse(parsed).roles).toEqual(roles);
    expect(EngineRunCreateSchema.parse({ ...runRequest, runId: RUN, roles }).roles).toEqual(roles);
    // A run state stored before requests had roles still parses.
    expect(RunStateSchema.parse(runState).request).not.toHaveProperty("roles");
  });

  it("refuses starting roles of the wrong shape", () => {
    const bad = [
      { disprover: ["codex", "copilot"] },
      { fixer: ["claude"] },
      { reviewer: [] },
      { reviewer: "codex" },
      { confirmer: "gemini" },
    ];
    for (const roles of bad) {
      expect(RunRequestSchema.safeParse({ ...runRequest, roles }).success).toBe(false);
      expect(RoleOverridesSchema.safeParse(roles).success).toBe(false);
    }
  });

  it("gives each profile's default roles", () => {
    expect(profileRoles("offload", 1).reviewer).toEqual(["codex", "copilot"]);
    expect(profileRoles("balanced", 2).reviewer).toContain("claude");
    expect(profileRoles("balanced", 3).reviewer).not.toContain("claude");
    expect(profileRoles("fast", 1).disprover).toBe("claude");
  });

  it("round-trips a run state waiting for a decision", () => {
    const parsed = roundTrip(RunStateSchema, runState);
    expect(parsed.decision?.kind).toBe("oscillation");
    expect(parsed.roles.reviewer).toEqual(["codex", "copilot"]);
  });

  it("rejects an unknown stage and a non-ULID id", () => {
    expect(RunStateSchema.safeParse({ ...runState, stage: "deploy" }).success).toBe(false);
    expect(RunStateSchema.safeParse({ ...runState, id: "R-0001" }).success).toBe(false);
  });

  it("round-trips a file group and a round summary", () => {
    expect(roundTrip(FileGroupSchema, fileGroup)).toEqual(fileGroup);
    const summary = roundTrip(RoundSummarySchema, roundSummary);
    expect(summary.perVendor.copilot?.premiumRequests).toBe(3);
    expect(summary.perVendor.copilot?.aiCredits).toBe(1.5);
    expect(summary.perVendor.codex).not.toHaveProperty("aiCredits");
    expect(summary.perVendor.claude).toBeUndefined();
  });
});

describe("leases", () => {
  it("round-trips requests and every response", () => {
    expect(roundTrip(LeaseRequestSchema, leaseRequest)).toEqual(leaseRequest);
    for (const response of leaseResponses) {
      expect(roundTrip(LeaseResponseSchema, response)).toEqual(response);
    }
  });

  it("requires an expiry on a grant and an action on a denial", () => {
    expect(
      LeaseResponseSchema.safeParse({
        decision: "granted",
        leaseId: "L",
        vendor: "claude",
        redirectedFrom: null,
      }).success,
    ).toBe(false);
    expect(
      LeaseResponseSchema.safeParse({ decision: "deny", leaseId: "L", reason: "x" }).success,
    ).toBe(false);
    expect(LeaseResponseSchema.safeParse({ decision: "maybe", leaseId: "L" }).success).toBe(false);
  });

  it("wraps requests and responses in frames", () => {
    expect(LeaseRequestFrameSchema.parse({ type: "lease.request", ...leaseRequest })).toMatchObject(
      leaseRequest,
    );
    expect(
      LeaseResponseFrameSchema.parse({ type: "lease.response", response: leaseResponses[0] })
        .response.decision,
    ).toBe("granted");
  });
});

describe("the Copilot review option", () => {
  it("is off by default and on when a request names it", () => {
    expect(wantsCopilotReview(RunRequestSchema.parse(runRequest))).toBe(false);
    const on = RunRequestSchema.parse({ ...runRequest, copilotReview: true });
    expect(on.copilotReview).toBe(true);
    expect(wantsCopilotReview(on)).toBe(true);
  });

  it("keeps the review for a stored run that predates the option", () => {
    const { copilotReview: _option, ...stored } = RunRequestSchema.parse({
      ...runRequest,
      pipeline: "post-push",
    });
    const parsed = ResolvedRunRequestSchema.parse(stored);
    expect(parsed.copilotReview).toBeUndefined();
    expect(wantsCopilotReview(parsed)).toBe(true);
  });
});

describe("postPushRoundCap", () => {
  it("gives a pre-push run its own cap after a push, and keeps a post-push request's", () => {
    expect(postPushRoundCap({ pipeline: "pre-push", roundCap: 2 })).toBe(POST_PUSH_ROUND_CAP);
    expect(postPushRoundCap({ pipeline: "post-push", roundCap: 7 })).toBe(7);
  });
});

describe("the whole-project scope", () => {
  const body = { projectId: "p", repoPath: "/repo" };

  it("is optional, and a stored run without it still parses", () => {
    const parsed = RunRequestSchema.parse(body);
    expect(parsed.scope).toBeUndefined();
    expect(parsed.excludePaths).toBeUndefined();
    expect(parsed.mergeBase).toBe(true);
  });

  it("turns the merge base off, and parsing again changes nothing", () => {
    const parsed = RunRequestSchema.parse({ ...body, scope: "whole", excludePaths: ["a/**"] });
    expect(parsed).toMatchObject({ scope: "whole", mergeBase: false, excludePaths: ["a/**"] });
    expect(RunRequestSchema.parse(parsed)).toEqual(parsed);
  });

  it("refuses the post-push pipeline", () => {
    const parsed = RunRequestSchema.safeParse({
      ...body,
      scope: "whole",
      pipeline: "post-push",
      prNumber: 1,
    });
    expect(parsed.success).toBe(false);
  });
});
