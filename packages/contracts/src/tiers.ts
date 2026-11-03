// Model tiers for review runs: how strong a model each call uses, which
// vendor model each tier maps to, and the models a review run must never use.
import { z } from "zod";
import { VendorSchema, type Vendor } from "./common.js";

export const ModelTierSchema = z.enum(["small", "medium", "large"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

/** A run's tier setting: `auto` lets the engine choose per group and role. */
export const ModelTierChoiceSchema = z.enum(["auto", "small", "medium", "large"]);
export type ModelTierChoice = z.infer<typeof ModelTierChoiceSchema>;

/**
 * Text that a model name must not contain, per vendor, in any letter case.
 * Review runs never use these models. Change this list to change the rule.
 */
export const BLOCKED_REVIEW_MODELS: Partial<Record<Vendor, readonly string[]>> = {
  claude: ["fable"],
  codex: ["astra"],
};

/** True when review runs must not use `model` on `vendor`. */
export function isBlockedReviewModel(vendor: Vendor, model: string): boolean {
  const name = model.toLowerCase();
  return (BLOCKED_REVIEW_MODELS[vendor] ?? []).some((text) => name.includes(text.toLowerCase()));
}

/**
 * True when a person or config must not ask for `model` on `vendor`. Stricter
 * than `isBlockedReviewModel`: Copilot's automatic selection is exempt, but
 * naming a blocked model through Copilot isn't, since Copilot serves other
 * vendors' models.
 */
export function isBlockedRequestedModel(vendor: Vendor, model: string): boolean {
  if (vendor !== "copilot") return isBlockedReviewModel(vendor, model);
  const name = model.toLowerCase();
  return Object.values(BLOCKED_REVIEW_MODELS)
    .flat()
    .some((text) => name.includes(text.toLowerCase()));
}

/** The error text for a blocked model. */
export function blockedModelMessage(vendor: Vendor, model: string): string {
  const names = BLOCKED_REVIEW_MODELS[vendor] ?? Object.values(BLOCKED_REVIEW_MODELS).flat();
  return `Review runs can't use the ${vendor} model ${model}. Choose a model whose name doesn't contain ${names.join(" or ")}.`;
}

/** Throws when review runs must not use `model` on `vendor`. */
export function assertReviewModelAllowed(vendor: Vendor, model: string | undefined): void {
  if (model !== undefined && isBlockedRequestedModel(vendor, model)) {
    throw new Error(blockedModelMessage(vendor, model));
  }
}

const TierModelNamesSchema = z
  .object({
    small: z.string().min(1).optional(),
    medium: z.string().min(1).optional(),
    large: z.string().min(1).optional(),
  })
  .strict();

/**
 * The model for each vendor and tier. A vendor or tier left out uses the built-in
 * mapping in `DEFAULT_TIER_MODELS`, or the vendor's default when that has none.
 */
export const TierModelsSchema = z
  .record(VendorSchema, TierModelNamesSchema)
  .superRefine((map, ctx) => {
    for (const [vendor, tiers] of Object.entries(map) as [Vendor, Record<string, string>][]) {
      for (const [tier, model] of Object.entries(tiers)) {
        if (isBlockedRequestedModel(vendor, model)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [vendor, tier],
            message: blockedModelMessage(vendor, model),
          });
        }
      }
    }
  });
export type TierModels = z.infer<typeof TierModelsSchema>;

/**
 * The built-in mappings, pinned to exact model IDs. Copilot has no mapping and
 * keeps its automatic model selection.
 */
export const DEFAULT_TIER_MODELS: TierModels = {
  claude: { small: "claude-haiku-5-5", medium: "claude-sonnet-5-5", large: "claude-opus-5-5" },
  codex: { small: "gpt-6-luna", medium: "gpt-6-sol", large: "gpt-6.1-sol" },
};

/**
 * The model for a call with no other model on a vendor whose CLI default can
 * be a blocked model, so the call never falls through to that default.
 */
export const BLOCKED_DEFAULT_FALLBACK: Partial<Record<Vendor, string>> = {
  claude: "claude-opus-5-5",
  codex: "gpt-6.1-sol",
};

/** Gives a set of files a tier in the policy file. */
export const TierPathRuleSchema = z
  .object({ paths: z.array(z.string().min(1)).min(1), tier: ModelTierSchema })
  .strict();
export type TierPathRule = z.infer<typeof TierPathRuleSchema>;
