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

  it("rejects an unknown version", () => {
    expect(PolicyFileSchema.safeParse({ version: 2 }).success).toBe(false);
  });
});
