// Chooses model tiers. Pure and deterministic: the same signals always give
// the same tier, and nothing here calls a model or runs a command.
import type { AgentRole, FileGroup, ModelTier, ModelTierChoice, RunDepth } from "@aio/contracts";

/** Starting guesses from the plan; change them from logged data. */
export const TIER_THRESHOLDS = {
  mediumReferences: 3,
  largeReferences: 10,
} as const;

const ORDER: readonly ModelTier[] = ["small", "medium", "large"];

/** What the engine measured about one changed file. */
export interface FileSignals {
  path: string;
  /** Docs or a lockfile, by path. */
  noCode: boolean;
  /** A lockfile whose diff adds a URL on a host that it didn't use before. */
  lockSource: boolean;
  /** The changed symbol that the most other files mention, when one was counted. */
  references: { symbol: string; files: number } | null;
  /**
   * Why some reference counts or changed-code signals are missing: `timeout`
   * for the time limit, `error` for a git failure, and `diff` when the function
   * diff failed. The other signals still apply.
   */
  referencesSkipped: "timeout" | "error" | "diff" | null;
  exportedChange: boolean;
  schemaPath: boolean;
  /** `concurrency`, `migrations`, or `parsing`, when the changed code has it. */
  risky: string | null;
  riskPath: boolean;
  /** The tier a policy `tierPaths` rule gives the file. */
  pinned: ModelTier | null;
  /** What a renamed file's old path asks for, so a rename can't lower the tier. */
  oldPathTier: { tier: ModelTier; why: string } | null;
}

export interface TierChoice {
  tier: ModelTier;
  reason: string;
}

export function tierRank(tier: ModelTier): number {
  return ORDER.indexOf(tier);
}

/** Gets the highest tier in the groups covered by a call. */
export function strongestGroupTier(groups: readonly FileGroup[]): TierChoice | null {
  let best: TierChoice | null = null;
  for (const group of groups) {
    if (group.tier && (!best || tierRank(group.tier) > tierRank(best.tier))) {
      best = { tier: group.tier, reason: group.tierReason ?? `Group ${group.id}.` };
    }
  }
  return best;
}

export function higherTier(a: ModelTier, b: ModelTier): ModelTier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/** One tier up, at most `large`. */
export function nextTier(tier: ModelTier): ModelTier {
  return ORDER[Math.min(tierRank(tier) + 1, ORDER.length - 1)] as ModelTier;
}

const SKIPPED_NOTES: Record<NonNullable<FileSignals["referencesSkipped"]> | "none", string> = {
  none: "",
  timeout: "; reference counts ran out of time",
  error: "; a reference count failed",
  diff: "; the function diff failed, so the changed-code signals are missing",
};

/** The tier one changed file asks for. */
export function fileTier(s: FileSignals): TierChoice {
  const own = currentPathTier(s);
  const old = s.oldPathTier;
  return old && tierRank(old.tier) > tierRank(own.tier)
    ? { tier: old.tier, reason: `${s.path}: ${old.why}` }
    : own;
}

function currentPathTier(s: FileSignals): TierChoice {
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
  if (s.noCode && s.lockSource)
    return at("medium", "a lockfile that changes a dependency's source");
  if (s.noCode) return at("small", "only docs or a lockfile");
  const skipped = SKIPPED_NOTES[s.referencesSkipped ?? "none"];
  const used = s.references?.files ?? 0;
  if (s.exportedChange) {
    // An exported change that few files use is no riskier than other code. A
    // count that didn't finish counts as used, so doubt stays at large.
    if (used >= TIER_THRESHOLDS.mediumReferences || s.referencesSkipped) {
      return at("large", `changes an exported API${skipped}`);
    }
  }
  if (s.schemaPath) return at("large", "changes a schema");
  if (s.references && used >= TIER_THRESHOLDS.largeReferences) {
    return at("large", `${s.references.symbol} appears in ${used} other files`);
  }
  if (s.risky) return at("large", `the changed code involves ${s.risky}`);
  if (s.references && used >= TIER_THRESHOLDS.mediumReferences) {
    return at("medium", `${s.references.symbol} appears in ${used} other files${skipped}`);
  }
  if (s.exportedChange) {
    return at("medium", `changes an exported API that ${used} other files use`);
  }
  return at("medium", `changes code${skipped}`);
}

/**
 * The tier one changed file asks for at the `standard` depth: only a policy
 * rule or a risk path goes above medium, and docs and lockfiles stay small.
 */
export function standardFileTier(s: FileSignals): TierChoice {
  if (s.pinned || s.riskPath || s.noCode) return fileTier(s);
  return { tier: "medium", reason: `${s.path}: changes code` };
}

/** A group's tier: its strongest file's tier, or the run's fixed tier. */
export function groupTier(
  files: readonly FileSignals[],
  choice: ModelTierChoice,
  depth: RunDepth = "thorough",
): TierChoice {
  if (choice === "small" && (files.length === 0 || files.some((f) => !f.noCode || f.lockSource))) {
    return {
      tier: "medium",
      reason: "The run uses the small tier, but code stays at medium or above.",
    };
  }
  if (choice !== "auto") return { tier: choice, reason: `The run uses the ${choice} tier.` };
  let best: TierChoice | null = null;
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const next = depth === "standard" ? standardFileTier(file) : fileTier(file);
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
  options: { choice: ModelTierChoice; persisting: boolean; depth?: RunDepth },
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
  if (options.depth === "standard") return standardRoleTier(from, role);
  let tier = from.tier;
  const notes = [from.reason];
  if (role === "disprover" || role === "confirmer") {
    // With no measured group there is nothing to step up from.
    tier = base ? higherTier(nextTier(tier), "medium") : "medium";
    notes.push(`a ${role} takes one tier up, at medium or above`);
  } else if (role === "fixer") {
    tier = higherTier(tier, "medium");
    notes.push("a fixer takes medium or above");
  }
  if (persisting) {
    tier = nextTier(tier);
    notes.push("findings persist from an earlier round, so one tier up");
  }
  // After the persistence move, so the cap holds for a whole-diff sweep.
  if (role === "sweeper" && tierRank(tier) > tierRank("medium")) {
    tier = "medium";
    notes.push("a sweeper takes medium at most");
  }
  return { tier, reason: notes.join("; ") };
}

/**
 * The tier of one call at the `standard` depth, with no moves up. A call takes
 * its group's tier. A disprover on a docs-only group can stay small; a fixer
 * stays at medium or above, a confirmer takes large, and a sweeper stays at
 * medium or below.
 */
function standardRoleTier(from: TierChoice, role: AgentRole): TierChoice {
  // One call checks every fix of the round, so it costs little and matters most.
  if (role === "confirmer") {
    return { tier: "large", reason: `${from.reason}; a confirmer takes large` };
  }
  if (role === "fixer") {
    const tier = higherTier(from.tier, "medium");
    return { tier, reason: `${from.reason}; a ${role} takes medium or above` };
  }
  if (role === "sweeper" && tierRank(from.tier) > tierRank("medium")) {
    return { tier: "medium", reason: `${from.reason}; a sweeper takes medium at most` };
  }
  return from;
}
