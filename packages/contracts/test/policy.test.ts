import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, PolicyFileSchema } from "../src/index.js";
import { policy } from "./fixtures.js";
import { roundTrip } from "./helpers.js";

describe("policy", () => {
  it("round-trips a policy file", () => {
    expect(roundTrip(PolicyFileSchema, policy)).toEqual(policy);
  });

  it("has a default with a 400-line group limit", () => {
    expect(DEFAULT_POLICY).toEqual({
      version: 1,
      riskPaths: [],
      rules: [],
      tests: [],
      lint: [],
      environmentLimits: [],
      groupSizeLimit: 400,
    });
  });

  it("accepts commentAuthors and rejects a non-list value", () => {
    expect(PolicyFileSchema.parse({ ...policy, commentAuthors: ["alice"] }).commentAuthors).toEqual(
      ["alice"],
    );
    expect(PolicyFileSchema.safeParse({ version: 1, commentAuthors: "alice" }).success).toBe(false);
  });

  it("rejects an unknown version and an unknown key", () => {
    expect(PolicyFileSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(PolicyFileSchema.safeParse({ version: 1, risk_paths: ["src/**"] }).success).toBe(false);
  });
});
