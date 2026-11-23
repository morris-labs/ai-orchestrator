// Turns a seat placement into an agent call for the shared core.
import { VendorSchema, type SeatPlacement } from "@aio/contracts";
import type { AgentCallSpec } from "../../calls/index.js";

/** A build step's call before its placement sets the vendor, tier, and effort. */
export type PlacedCallSpec = Omit<
  AgentCallSpec,
  "vendor" | "tier" | "allowFallback" | "avoid" | "pinVendor" | "placement"
>;

/**
 * Places a call on the seat's placement: its vendor, a fixed tier, and its
 * effort. A build call never moves to another vendor: a limit waits for the
 * reset, and a server grant on another vendor stops the call for a decision,
 * so the rules that require a different vendor keep holding. A fresh
 * placement drops the session to resume.
 */
export function placeCall(spec: PlacedCallSpec, placement: SeatPlacement): AgentCallSpec {
  const { sessionId, ...request } = spec.request;
  return {
    ...spec,
    vendor: placement.vendor,
    tier: {
      tier: placement.tier,
      reason: `the ${placement.seat} seat's placement (tier from the ${placement.sources.tier} level)`,
      fixed: true,
    },
    request: {
      ...request,
      effort: placement.effort,
      ...(sessionId !== undefined && !placement.fresh ? { sessionId } : {}),
    },
    allowFallback: false,
    avoid: VendorSchema.options.filter((v) => v !== placement.vendor),
    pinVendor: true,
    placement,
  };
}
