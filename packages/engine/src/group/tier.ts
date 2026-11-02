// Chooses model tiers. Pure and deterministic: the same signals always give
// the same tier, and nothing here calls a model or runs a command.
import type { AgentRole, ModelTier, ModelTierChoice } from "@aio/contracts";

/** Starting guesses from the plan; change them from logged data. */
export const TIER_THRESHOLDS = {
  fileLines: 200,
  changedLines: 50,
  mediumReferences: 3,
  largeReferences: 10,
} as const;

const ORDER: readonly ModelTier[] = ["small", "medium", "large"];

/** What the engine measured about one changed file. */
export interface FileSignals {
  path: string;
  /** Docs, a lockfile, or a change to only comments or formatting. */
  noCode: boolean;
  fileLines: number;
  changedLines: number;
  /** The changed symbol that the most other files mention, when one was counted. */
  references: { symbol: string; files: number } | null;
  /** The time limit stopped the reference counts; the other signals still apply. */
  referencesSkipped: boolean;
  exportedChange: boolean;
  schemaPath: boolean;
  /** `concurrency`, `migrations`, or `parsing`, when the changed code has it. */
  risky: string | null;
  riskPath: boolean;
  /** The tier a policy `tierPaths` rule gives the file. */
  pinned: ModelTier | null;
}

export interface TierChoice {
  tier: ModelTier;
  reason: string;
}

export function tierRank(tier: ModelTier): number {
  return ORDER.indexOf(tier);
}

export function higherTier(a: ModelTier, b: ModelTier): ModelTier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/** One tier up, at most `large`. */
export function nextTier(tier: ModelTier): ModelTier {
  return ORDER[Math.min(tierRank(tier) + 1, ORDER.length - 1)] as ModelTier;
}

/** The tier one changed file asks for. */
export function fileTier(s: FileSignals): TierChoice {
  const at = (tier: ModelTier, why: string): TierChoice => ({
    tier,
    reason: `${s.path}: ${why}`,
  });
  if (s.pinned) {
    return s.pinned === "small" && !s.noCode
      ? at("medium", "the policy's tierPaths sets small, but code stays at medium or above")
      : at(s.pinned, "the policy's tierPaths sets this tier");
  }
  if (s.riskPath) return at("large", "matches a risk path");
  if (s.noCode) return at("small", "only docs, comments, formatting, or a lockfile");
  if (s.exportedChange) return at("large", "changes an exported API");
  if (s.schemaPath) return at("large", "changes a schema");
  if (s.references && s.references.files >= TIER_THRESHOLDS.largeReferences) {
    return at("large", `${s.references.symbol} appears in ${s.references.files} other files`);
  }
  if (s.risky) return at("large", `the changed code involves ${s.risky}`);
  const skipped = s.referencesSkipped ? "; reference counts ran out of time" : "";
  if (s.references && s.references.files >= TIER_THRESHOLDS.mediumReferences) {
    return at(
      "medium",
      `${s.references.symbol} appears in ${s.references.files} other files${skipped}`,
    );
  }
  if (s.fileLines > TIER_THRESHOLDS.fileLines) {
    return at("medium", `code in a file of ${s.fileLines} lines${skipped}`);
  }
  if (s.changedLines > TIER_THRESHOLDS.changedLines) {
    return at("medium", `${s.changedLines} changed lines of code${skipped}`);
  }
  return at("medium", `changes code${skipped}`);
}

/** A group's tier: its strongest file's tier, or the run's fixed tier. */
export function groupTier(files: readonly FileSignals[], choice: ModelTierChoice): TierChoice {
  if (choice === "small" && (files.length === 0 || files.some((f) => !f.noCode))) {
    return {
      tier: "medium",
      reason: "The run uses the small tier, but code stays at medium or above.",
    };
  }
  if (choice !== "auto") return { tier: choice, reason: `The run uses the ${choice} tier.` };
  let best: TierChoice | null = null;
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const next = fileTier(file);
    if (!best || tierRank(next.tier) > tierRank(best.tier)) best = next;
  }
  return best ?? { tier: "medium", reason: "The group has no measured file." };
}

const AT_LEAST_MEDIUM: readonly AgentRole[] = ["disprover", "confirmer", "fixer"];

/**
 * The tier of one call. `base` is the tier of the groups the call covers, or
 * `null` when no group covers it. A fixed run keeps its tier, except that
 * code, disprovers, confirmers, and fixers stay at medium or above.
 */
export function roleTier(
  base: TierChoice | null,
  role: AgentRole,
  options: { choice: ModelTierChoice; persisting: boolean },
): TierChoice {
  const { choice, persisting } = options;
  const floor = AT_LEAST_MEDIUM.includes(role);
  if (choice !== "auto") {
    // Only a group the engine measured as free of code can stay small.
    const noCodeOnly = !floor && base?.tier === "small";
    const tier = choice === "small" && !noCodeOnly ? "medium" : choice;
    return {
      tier,
      reason:
        tier === choice
          ? `The run uses the ${choice} tier.`
          : `The run uses the ${choice} tier; code and a ${role} stay at medium or above.`,
    };
  }
  const from = base ?? { tier: "medium" as const, reason: "No group covers the call." };
  let tier = from.tier;
  const notes = [from.reason];
  if (role === "disprover" || role === "confirmer") {
    tier = higherTier(nextTier(tier), "medium");
    notes.push(`a ${role} takes one tier up, at medium or above`);
  } else if (role === "fixer") {
    tier = higherTier(tier, "medium");
    notes.push("a fixer takes medium or above");
  } else if (role === "sweeper" && tierRank(tier) > tierRank("medium")) {
    tier = "medium";
    notes.push("a sweeper takes medium at most");
  }
  if (persisting) {
    tier = nextTier(tier);
    notes.push("findings persist from an earlier round, so one tier up");
  }
  return { tier, reason: notes.join("; ") };
}
