// Model choice and a plain routing for callers without role rules of their own.
import {
  BLOCKED_DEFAULT_FALLBACK,
  DEFAULT_TIER_MODELS,
  type ModelTier,
  type PolicyFile,
  type Vendor,
} from "@aio/contracts";
import type { EngineDeps } from "../core.js";
import type { CallRouting } from "./types.js";

/**
 * Chooses a model for `vendor` at `tier`: the policy's mapping, then the
 * built-in one. With no tier, the engine's model for the vendor. With
 * `preferBuiltIn`, the built-in mapping wins over the policy's.
 */
export function chooseTierModel(
  models: EngineDeps["models"],
  tierModels: PolicyFile["tierModels"],
  vendor: Vendor,
  tier: ModelTier | undefined,
  preferBuiltIn = false,
): { model: string | undefined; note: string | null } {
  const existing = models?.[vendor] ?? BLOCKED_DEFAULT_FALLBACK[vendor];
  if (!tier) return { model: existing, note: null };
  const builtIn = DEFAULT_TIER_MODELS[vendor]?.[tier];
  const mapped = preferBuiltIn && builtIn ? builtIn : (tierModels?.[vendor]?.[tier] ?? builtIn);
  if (mapped) return { model: mapped, note: null };
  return {
    model: existing,
    note: `${vendor} has no mapping for the ${tier} tier, so the call uses ${existing ?? "the CLI's default model"}`,
  };
}

/** Options for `basicRouting`. */
export interface BasicRoutingOptions {
  /** The order to try vendors in when one hits a limit. */
  fallbackOrder: readonly Vendor[];
  /** The timeout for a call that names none, in milliseconds. */
  timeoutMs: number;
  /** The engine's model per vendor. */
  models?: EngineDeps["models"];
  /** The policy's tier mapping. */
  tierModels?: PolicyFile["tierModels"];
}

/**
 * Routing with no role rules: every vendor takes every role, a call moves on
 * a limit unless it sets `allowFallback: false` or continues a session, and
 * moves are not recorded anywhere.
 */
export function basicRouting(options: BasicRoutingOptions): CallRouting {
  return {
    fallbackOrder: options.fallbackOrder,
    canTake: () => true,
    movable: (spec) => spec.allowFallback !== false && spec.method !== "continueReview",
    assigned: (_spec, vendor) => vendor,
    moved: () => Promise.resolve(),
    model: (vendor, tier) => chooseTierModel(options.models, options.tierModels, vendor, tier),
    timeoutMs: () => options.timeoutMs,
  };
}
