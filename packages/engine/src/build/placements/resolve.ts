// Resolves a seat's placement from its levels: the role default, the
// single-vendor setting, the build plan, and a live change.
import { VendorSchema } from "@aio/contracts";
import type {
  Placement,
  PlacementLevel,
  PlacementOverride,
  PlacementSources,
  RoleName,
  SeatPlacement,
  Vendor,
} from "@aio/contracts";

/** A placement that breaks the single-vendor setting or a rule that requires another vendor. */
export class PlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlacementError";
  }
}

/** The levels for one seat, from weakest to strongest. */
export interface PlacementInput {
  seat: RoleName;
  /** The role library default. */
  role: Placement;
  /** The single vendor every seat runs on, or `null` or absent when the setting is off. */
  singleVendor?: Vendor | null | undefined;
  /** The build plan's placement for the seat. */
  plan?: PlacementOverride | undefined;
  /** The live change for the seat: every live change merged, latest last. */
  live?: PlacementOverride | undefined;
  /**
   * The vendor a rule keeps the seat off, such as the vendor whose work the
   * seat checks. With the single-vendor setting, the seat stays on its vendor
   * and runs as a fresh agent instead.
   */
  otherThan?: Vendor | undefined;
  /**
   * True when nobody chose the role default's vendor for this project, as
   * for a role from the shipped library. A rule that excludes that vendor
   * then moves the seat to another vendor instead of throwing.
   */
  movable?: boolean | undefined;
}

const FIELDS = ["vendor", "tier", "effort"] as const;

/**
 * Applies each level over the one before it. A seat on a movable role
 * default moves to the first other vendor when a rule excludes that vendor.
 * Throws `PlacementError` when a plan or live vendor breaks the single-vendor
 * setting, or when a vendor that the plan, a live change, or a repository
 * role chose breaks a rule that requires another vendor and the setting is off.
 */
export function resolvePlacement(input: PlacementInput): SeatPlacement {
  const placement: Placement = { ...input.role };
  const sources: PlacementSources = { vendor: "role", tier: "role", effort: "role" };
  const single = input.singleVendor ?? null;
  if (single) {
    placement.vendor = single;
    sources.vendor = "single-vendor";
  }
  const levels: [PlacementLevel, PlacementOverride | undefined][] = [
    ["plan", input.plan],
    ["live", input.live],
  ];
  for (const [level, override] of levels) {
    if (!override) continue;
    if (single && override.vendor !== undefined && override.vendor !== single) {
      const where = level === "plan" ? "The build plan" : "A live change";
      throw new PlacementError(
        `${where} places the ${input.seat} seat on ${override.vendor}, but the single-vendor setting places every seat on ${single}.`,
      );
    }
    for (const field of FIELDS) {
      if (override[field] === undefined) continue;
      Object.assign(placement, { [field]: override[field] });
      sources[field] = level;
    }
  }
  const resolved: SeatPlacement = { seat: input.seat, ...placement, sources, fresh: false };
  if (input.otherThan === undefined || input.otherThan !== placement.vendor) return resolved;
  if (single) {
    return {
      ...resolved,
      fresh: true,
      note: `A rule requires a vendor other than ${single}, but the single-vendor setting keeps every seat on ${single}, so a fresh agent takes the ${input.seat} seat.`,
    };
  }
  // Nobody chose the library default's vendor for this build, so the engine
  // picks another one instead of stopping it.
  const other = VendorSchema.options.find((v) => v !== input.otherThan);
  if (input.movable && sources.vendor === "role" && other) {
    return {
      ...resolved,
      vendor: other,
      note: `A rule requires a vendor other than ${input.otherThan} for the ${input.seat} seat, whose role default is ${placement.vendor}, so the engine places it on ${other}.`,
    };
  }
  throw new PlacementError(
    `The ${input.seat} seat requires a vendor other than ${input.otherThan}, but its placement puts it on ${placement.vendor}. Place the seat on another vendor, or turn on the single-vendor setting.`,
  );
}
