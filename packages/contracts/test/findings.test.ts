import { describe, expect, it } from "vitest";
import { FindingSchema, VendorFindingSchema, fromVendorFinding } from "../src/index.js";
import { finding } from "./fixtures.js";
import { roundTrip } from "./helpers.js";

describe("findings", () => {
  it("round-trips a finding with its history", () => {
    expect(roundTrip(FindingSchema, finding)).toEqual(finding);
  });

  it("rejects an end line before the start line", () => {
    expect(FindingSchema.safeParse({ ...finding, lines: [10, 9] }).success).toBe(false);
  });

  it("rejects an unknown verdict", () => {
    expect(FindingSchema.safeParse({ ...finding, verdict: "maybe" }).success).toBe(false);
  });

  it("converts the design.md vendor JSON", () => {
    const raw = VendorFindingSchema.parse({
      id: "F-0001",
      fingerprint: "ignored",
      severity: "P2",
      title: "Unchecked error",
      file: "src/parser.py",
      lines: [120, 134],
      failure_case: "Input X leads to Z.",
      category: "error-handling",
      introduced: true,
      reported_by: "claude-opus",
      verdict: "pending",
    });
    const converted = fromVendorFinding(raw, {
      id: "F-0042",
      fingerprint: "abc",
      reportedBy: "claude-opus",
      runId: "R-0001",
      round: 2,
      groupId: "G-02",
    });
    expect(converted).toMatchObject({
      id: "F-0042",
      failureCase: "Input X leads to Z.",
      verdict: "pending",
      verification: null,
      evidence: "",
      hunkIds: [],
      history: [],
      origin: "reviewer",
    });
  });
});
