// A build's seat placements: the levels above the role defaults, live changes
// included, and the placement each new agent in a seat runs on.
import {
  BuildPlacementsSchema,
  type BuildPlacements,
  type BuildPlacementsInput,
  type LivePlacementChange,
  type Placement,
  type PlacementOverride,
  type RoleName,
  type SeatPlacement,
  type Vendor,
} from "@aio/contracts";
import { PlacementError, resolvePlacement } from "./resolve.js";

/** The roles a build seats, by name, as `loadRoles()` returns them. */
export type SeatRoles = ReadonlyMap<string, { readonly placement: Placement }>;

/** Options for placing one agent in a seat. */
export interface PlaceOptions {
  /** The vendor a rule keeps the seat off, such as the vendor whose work the seat checks. */
  otherThan?: Vendor;
}

/**
 * Holds a build's placement levels. Call `place()` when an agent starts in a
 * seat: the agent keeps that placement for its whole turn, and a later
 * `change()` applies only to the seat's next agent.
 */
export class SeatPlacements {
  private readonly levels: BuildPlacements;

  constructor(
    private readonly roles: SeatRoles,
    saved: BuildPlacementsInput,
  ) {
    this.levels = BuildPlacementsSchema.parse(saved);
  }

  /** The placement for the seat's next agent. Throws `PlacementError` for a seat the build lacks. */
  place(seat: RoleName, options: PlaceOptions = {}): SeatPlacement {
    return resolvePlacement({
      seat,
      role: this.defaultOf(seat),
      singleVendor: this.levels.singleVendor,
      plan: this.levels.plan[seat],
      live: this.liveOf(seat),
      otherThan: options.otherThan,
    });
  }

  /**
   * Records a live change for the seat's next agent. Throws `PlacementError`,
   * and records nothing, when the change breaks the single-vendor setting.
   */
  change(
    seat: RoleName,
    placement: PlacementOverride,
    at: string = new Date().toISOString(),
  ): LivePlacementChange {
    const live = { ...this.liveOf(seat), ...placement };
    resolvePlacement({
      seat,
      role: this.defaultOf(seat),
      singleVendor: this.levels.singleVendor,
      plan: this.levels.plan[seat],
      live,
    });
    const change: LivePlacementChange = { seat, placement: { ...placement }, at };
    this.levels.live.push(change);
    return change;
  }

  /** The levels to save in the build's state; `new SeatPlacements(roles, saved)` restores them. */
  state(): BuildPlacements {
    return structuredClone(this.levels);
  }

  private defaultOf(seat: RoleName): Placement {
    const role = this.roles.get(seat);
    if (!role) throw new PlacementError(`The build has no ${seat} role to place.`);
    return role.placement;
  }

  /** Every live change for the seat merged in order, or `undefined` with none. */
  private liveOf(seat: RoleName): PlacementOverride | undefined {
    const changes = this.levels.live.filter((c) => c.seat === seat);
    if (changes.length === 0) return undefined;
    return Object.assign({}, ...changes.map((c) => c.placement)) as PlacementOverride;
  }
}
