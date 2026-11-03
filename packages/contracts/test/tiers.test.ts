import { describe, expect, it } from "vitest";
import {
  BLOCKED_DEFAULT_FALLBACK,
  DEFAULT_TIER_MODELS,
  EngineRunCreateSchema,
  FileGroupSchema,
  PolicyFileSchema,
  ResolvedRunRequestSchema,
  TierModelsSchema,
  assertReviewModelAllowed,
  isBlockedReviewModel,
} from "../src/index.js";

describe("blocked review models", () => {
  it.each([
    ["claude", "fable", true],
    ["claude", "claude-FABLE-5-1", true],
    ["claude", "claude-opus-5-5", false],
    ["codex", "gpt-6-astra", true],
    ["codex", "GPT-6-Astra", true],
    ["codex", "gpt-6-sol", false],
    ["copilot", "gpt-6-astra", false],
  ] as const)("%s %s is %s", (vendor, model, blocked) => {
    expect(isBlockedReviewModel(vendor, model)).toBe(blocked);
  });

  it("refuses an explicit blocked model with a clear error", () => {
    expect(() => assertReviewModelAllowed("codex", "gpt-6-astra")).toThrow(/can't use the codex/);
    expect(() => assertReviewModelAllowed("claude", undefined)).not.toThrow();
  });

  it("refuses a blocked model in a mapping and in the policy", () => {
    expect(TierModelsSchema.safeParse({ claude: { large: "Fable" } }).success).toBe(false);
    expect(
      PolicyFileSchema.safeParse({ version: 1, tierModels: { codex: { large: "gpt-6-astra" } } })
        .success,
    ).toBe(false);
    expect(
      PolicyFileSchema.safeParse({ version: 1, tierModels: { codex: { large: "gpt-6-sol" } } })
        .success,
    ).toBe(true);
  });

  it.each(["claude-fable-5-1", "GPT-6-Astra"])(
    "refuses %s named through Copilot in the policy",
    (model) => {
      const parsed = PolicyFileSchema.safeParse({
        version: 1,
        tierModels: { copilot: { large: model } },
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.path).toEqual(["tierModels", "copilot", "large"]);
      expect(parsed.error?.issues[0]?.message).toContain(model);
    },
  );

  it("accepts an allowed model and automatic selection through Copilot", () => {
    for (const model of ["auto", "gpt-6-sol"]) {
      expect(TierModelsSchema.safeParse({ copilot: { large: model } }).success).toBe(true);
    }
  });

  it("keeps the defaults clear of the list", () => {
    expect(DEFAULT_TIER_MODELS.claude).toEqual({
      small: "claude-haiku-5-5",
      medium: "claude-sonnet-5-5",
      large: "claude-opus-5-5",
    });
    expect(DEFAULT_TIER_MODELS.codex).toEqual({
      small: "gpt-6-luna",
      medium: "gpt-6-sol",
      large: "gpt-6.1-sol",
    });
    expect(DEFAULT_TIER_MODELS.copilot).toBeUndefined();
    expect(BLOCKED_DEFAULT_FALLBACK.copilot).toBeUndefined();
    for (const vendor of ["claude", "codex"] as const) {
      const fallback = BLOCKED_DEFAULT_FALLBACK[vendor] ?? "";
      expect(fallback).not.toBe("");
      expect(isBlockedReviewModel(vendor, fallback)).toBe(false);
      for (const model of Object.values(DEFAULT_TIER_MODELS[vendor] ?? {})) {
        expect(isBlockedReviewModel(vendor, model)).toBe(false);
      }
    }
  });
});

describe("optional tier fields", () => {
  it("parses a group and a request without them", () => {
    expect(
      FileGroupSchema.safeParse({
        id: "G01",
        files: ["a.ts"],
        kind: "minor",
        changedLines: 1,
        riskPath: false,
        hunks: [],
      }).success,
    ).toBe(true);
    const parsed = EngineRunCreateSchema.parse({
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      projectId: "p",
      repoPath: "/w",
    });
    expect(parsed.modelTier).toBeUndefined();
    expect(ResolvedRunRequestSchema.shape.modelTier.isOptional()).toBe(true);
  });
});
