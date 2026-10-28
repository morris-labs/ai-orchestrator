import { describe, expect, it } from "vitest";
import {
  EngineRunCreateSchema,
  FileGroupSchema,
  LeaseRequestFrameSchema,
  LeaseRequestSchema,
  LeaseResponseFrameSchema,
  LeaseResponseSchema,
  ResolvedRunRequestSchema,
  RoundSummarySchema,
  RunRequestSchema,
  RunStateSchema,
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
      roundCap: 25,
      overlapThreshold: 0.5,
      continuationCap: 3,
    });
    expect(ResolvedRunRequestSchema.parse(parsed)).toEqual(parsed);
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
