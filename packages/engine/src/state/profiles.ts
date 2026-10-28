// Profiles and role assignment (design.md, "Profiles" and "Vendor roles").
import type { FileGroup, Profile, RoleAssignment, Vendor } from "@agentbox/contracts";
import { FOCUS_AREAS } from "../prompts/templates.js";

/** Rounds in which the `balanced` profile has Claude review. */
export const BALANCED_CLAUDE_ROUNDS = 2;

/** The roles a profile gives in a round, before availability and manual changes. */
export function profileRoles(profile: Profile, round: number): RoleAssignment {
  switch (profile) {
    case "offload":
      return {
        reviewer: ["codex", "copilot"],
        disprover: "codex",
        confirmer: "codex",
        fixer: "claude",
      };
    case "balanced":
      return round <= BALANCED_CLAUDE_ROUNDS
        ? {
            reviewer: ["claude", "codex", "copilot"],
            disprover: "codex",
            confirmer: "codex",
            fixer: "claude",
          }
        : {
            reviewer: ["codex", "copilot"],
            disprover: "codex",
            confirmer: "codex",
            fixer: "claude",
          };
    case "fast":
      return {
        reviewer: ["claude", "codex"],
        disprover: "claude",
        confirmer: "codex",
        fixer: "claude",
      };
  }
}

export interface RoleOptions {
  profile: Profile;
  round: number;
  /** Vendors with an adapter. */
  available: readonly Vendor[];
  /** Roles a person assigned by hand. */
  manual?: Partial<RoleAssignment>;
  /** High overlap switched reviewers to alternate across rounds. */
  alternating?: boolean;
  /** With `crossVendor`, the confirmer must differ from the fixer. */
  crossVendor: boolean;
}

function firstAvailable(preferred: Vendor, available: readonly Vendor[], avoid?: Vendor): Vendor {
  if (available.includes(preferred) && preferred !== avoid) return preferred;
  const order: Vendor[] = ["codex", "copilot", "claude"];
  return (
    order.find((v) => available.includes(v) && v !== avoid) ??
    order.find((v) => available.includes(v)) ??
    preferred
  );
}

/** The role assignment for a round, after manual changes, availability, and alternation. */
export function assignRoles(options: RoleOptions): RoleAssignment {
  const base = profileRoles(options.profile, options.round);
  const manual = options.manual ?? {};
  let reviewer = (manual.reviewer ?? base.reviewer).filter((v) => options.available.includes(v));
  if (reviewer.length === 0)
    reviewer = [firstAvailable(base.reviewer[0] as Vendor, options.available)];
  if (options.alternating && reviewer.length > 1) {
    reviewer = [reviewer[(options.round - 1) % reviewer.length] as Vendor];
  }
  const fixer = firstAvailable(manual.fixer ?? base.fixer, options.available);
  const disprover = firstAvailable(manual.disprover ?? base.disprover, options.available);
  const confirmer = firstAvailable(
    manual.confirmer ?? base.confirmer,
    options.available,
    options.crossVendor ? fixer : undefined,
  );
  return { reviewer, disprover, confirmer, fixer };
}

export interface ReviewTask {
  /** Stable key for the call cache, such as `G01-codex`. */
  key: string;
  vendor: Vendor;
  /** `null` for a whole-diff review. */
  groupId: string | null;
  focusAreas: readonly string[] | null;
}

/**
 * The reviewer calls of a round. Copilot reviews the whole diff. The other
 * reviewers take the groups: a major group gets two of them with split focus
 * areas, and a minor group gets one, in turn. In the `fast` profile every
 * group gets two.
 */
export function planReviews(
  reviewers: readonly Vendor[],
  groups: readonly FileGroup[],
  profile: Profile,
): ReviewTask[] {
  const tasks: ReviewTask[] = [];
  const perGroup = reviewers.filter((v) => v !== "copilot");
  if (reviewers.includes("copilot")) {
    tasks.push({ key: "all-copilot", vendor: "copilot", groupId: null, focusAreas: null });
  }
  groups.forEach((group, index) => {
    if (perGroup.length === 0) return;
    const two = perGroup.length >= 2 && (group.kind === "major" || profile === "fast");
    if (two) {
      for (let i = 0; i < 2; i++) {
        const vendor = perGroup[i] as Vendor;
        tasks.push({
          key: `${group.id}-${vendor}`,
          vendor,
          groupId: group.id,
          focusAreas: FOCUS_AREAS[i] ?? null,
        });
      }
    } else {
      const vendor = perGroup[index % perGroup.length] as Vendor;
      tasks.push({ key: `${group.id}-${vendor}`, vendor, groupId: group.id, focusAreas: null });
    }
  });
  return tasks;
}
