import { describe, expect, it } from "vitest";
import {
  FileGroupSchema,
  LeaseRequestSchema,
  LeaseResponseSchema,
  RoundSummarySchema,
  RunRequestSchema,
  RunStateSchema,
} from "../src/index.js";
import {
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
  });

  it("turns off the merge base when exactBase is set", () => {
    expect(RunRequestSchema.parse({ ...runRequest, exactBase: true }).mergeBase).toBe(false);
  });

  it("round-trips a run request", () => {
    expect(roundTrip(RunRequestSchema, runRequest)).toMatchObject(runRequest);
  });

  it("round-trips a run state waiting for a decision", () => {
    const parsed = roundTrip(RunStateSchema, runState);
    expect(parsed.decision?.kind).toBe("oscillation");
    expect(parsed.roles.reviewer).toEqual(["codex", "copilot"]);
  });

  it("rejects an unknown stage", () => {
    expect(RunStateSchema.safeParse({ ...runState, stage: "deploy" }).success).toBe(false);
  });

  it("round-trips a file group and a round summary", () => {
    expect(roundTrip(FileGroupSchema, fileGroup)).toEqual(fileGroup);
    const summary = roundTrip(RoundSummarySchema, roundSummary);
    expect(summary.perVendor.copilot?.costUsd).toBe(0);
    expect(summary.perVendor.claude).toBeUndefined();
  });

  it("round-trips lease requests and every lease response", () => {
    expect(roundTrip(LeaseRequestSchema, leaseRequest)).toEqual(leaseRequest);
    for (const response of leaseResponses) {
      expect(roundTrip(LeaseResponseSchema, response)).toEqual(response);
    }
    expect(LeaseResponseSchema.safeParse({ decision: "maybe", leaseId: "L" }).success).toBe(false);
  });
});
