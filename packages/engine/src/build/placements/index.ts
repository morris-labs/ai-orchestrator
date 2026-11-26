// Build pipeline placements: the vendor, tier, and effort each seat runs on.
// See `docs/build-pipeline/design.md`, "Placement".
export { placeCall, type PlacedCallSpec } from "./call.js";
export { PlacementError, resolvePlacement, type PlacementInput } from "./resolve.js";
export { SeatPlacements, type PlaceOptions, type SeatRoles } from "./seats.js";
