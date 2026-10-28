import { describe, expect, it } from "vitest";
import {
  FindingInputSchema,
  FindingSchema,
  VendorFindingSchema,
  fromVendorFinding,
} from "../src/index.js";
import { RUN, finding, prCommentFinding } from "./fixtures.js";
import { roundTrip } from "./helpers.js";

describe("findings", () => {
  it("round-trips a finding with its history", () => {
    expect(roundTrip(FindingSchema, finding)).toEqual(finding);
  });

  it("allows a pull request comment without a location or group", () => {
    expect(roundTrip(FindingSchema, prCommentFinding)).toEqual(prCommentFinding);
  });

  it("requires a location on a reviewer finding", () => {
    expect(FindingSchema.safeParse({ ...finding, file: null, lines: null }).success).toBe(false);
  });

  it("requires file and lines to be null together", () => {
    expect(FindingSchema.safeParse({ ...prCommentFinding, lines: [1, 2] }).success).toBe(false);
  });

  it("rejects an end line before the start line, an unknown verdict, and a non-ULID run id", () => {
    expect(FindingSchema.safeParse({ ...finding, lines: [10, 9] }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...finding, verdict: "maybe" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...finding, runId: "R-0001" }).success).toBe(false);
  });

  it("has no defaults on the read schema", () => {
    const { history: _h, ...withoutHistory } = finding;
    expect(FindingSchema.safeParse(withoutHistory).success).toBe(false);
    expect(FindingInputSchema.parse(withoutHistory).history).toEqual([]);
  });

  it("requires introduced in vendor JSON", () => {
    const raw = {
      severity: "P2",
      title: "Unchecked error",
      file: "src/parser.py",
      lines: [120, 134],
      failure_case: "Input X leads to Z.",
      category: "error-handling",
    };
    expect(VendorFindingSchema.safeParse(raw).success).toBe(false);
    expect(VendorFindingSchema.safeParse({ ...raw, introduced: false }).success).toBe(true);
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
      runId: RUN,
      round: 2,
      groupId: "G-02",
    });
    expect(FindingSchema.parse(converted)).toMatchObject({
      id: "F-0042",
      failureCase: "Input X leads to Z.",
      verdict: "pending",
      verification: null,
      evidence: "",
      hunkIds: [],
      history: [],
      origin: "reviewer",
    });
    expect(converted).not.toHaveProperty("symbol");
  });

  it("carries a vendor's symbol into the finding", () => {
    const raw = VendorFindingSchema.parse({
      severity: "P3",
      title: "Off by one",
      file: "src/range.ts",
      symbol: "clampRange",
      lines: [4, 9],
      failure_case: "An empty range returns one item.",
      category: "correctness",
      introduced: true,
    });
    const converted = fromVendorFinding(raw, {
      id: "F-0003",
      fingerprint: "def",
      reportedBy: "codex-gpt-5",
      runId: RUN,
      round: 1,
      groupId: "G-01",
    });
    expect(converted.symbol).toBe("clampRange");
    expect(roundTrip(FindingSchema, { ...finding, symbol: "send" }).symbol).toBe("send");
  });
});
