// Build pipeline placements: the vendor, model tier, and effort that a seat
// runs on, and the levels that set them. See the "Placement" section of
// `docs/build-pipeline/design.md`.
import { z } from "zod";
import { EffortSchema, IsoDateTimeSchema, VendorSchema } from "./common.js";
import { RoleNameSchema } from "./build-roles.js";
import { ModelTierSchema } from "./tiers.js";

/** A vendor, a model tier, and an effort. */
export const PlacementSchema = z
  .object({
    vendor: VendorSchema,
    tier: ModelTierSchema,
    effort: EffortSchema,
  })
  .strict();
export type Placement = z.infer<typeof PlacementSchema>;

/** What one level changes: any of the three fields. An absent field keeps the level before. */
export const PlacementOverrideSchema = PlacementSchema.partial().strict();
export type PlacementOverride = z.infer<typeof PlacementOverrideSchema>;

/**
 * The placement levels, from weakest to strongest: the role library default,
 * the single-vendor setting, the build plan, and a live change.
 */
export const PlacementLevelSchema = z.enum(["role", "single-vendor", "plan", "live"]);
export type PlacementLevel = z.infer<typeof PlacementLevelSchema>;

/** The level each field of a resolved placement came from. */
export const PlacementSourcesSchema = z
  .object({
    vendor: PlacementLevelSchema,
    tier: PlacementLevelSchema,
    effort: PlacementLevelSchema,
  })
  .strict();
export type PlacementSources = z.infer<typeof PlacementSourcesSchema>;

/** The placement one agent in a seat runs on, as agent and usage events show it. */
export const SeatPlacementSchema = PlacementSchema.extend({
  /** The seat's role name, such as `developer`. */
  seat: RoleNameSchema,
  sources: PlacementSourcesSchema,
  /** True when the agent must start a fresh session instead of resuming one. */
  fresh: z.boolean(),
  /** Why the placement differs from what the levels alone give, such as a fresh agent for a rule. */
  note: z.string().min(1).optional(),
}).strict();
export type SeatPlacement = z.infer<typeof SeatPlacementSchema>;

/** A person's change to a seat's placement during execution. It applies to the seat's next agent. */
export const LivePlacementChangeSchema = z
  .object({
    seat: RoleNameSchema,
    placement: PlacementOverrideSchema,
    at: IsoDateTimeSchema,
  })
  .strict();
export type LivePlacementChange = z.infer<typeof LivePlacementChangeSchema>;

/**
 * A build's placement levels above the role defaults, as the build saves
 * them. `singleVendor` is `null` when the setting is off; `plan` holds the
 * build plan's placement per seat; `live` holds every live change in order.
 */
export const BuildPlacementsSchema = z
  .object({
    singleVendor: VendorSchema.nullable().default(null),
    plan: z.record(RoleNameSchema, PlacementOverrideSchema).default({}),
    live: z.array(LivePlacementChangeSchema).default([]),
  })
  .strict();
export type BuildPlacements = z.infer<typeof BuildPlacementsSchema>;
export type BuildPlacementsInput = z.input<typeof BuildPlacementsSchema>;
