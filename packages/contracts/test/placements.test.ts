// Build placements: the saved levels, a seat's placement, and the events that show it.
import { describe, expect, it } from "vitest";
import {
  BuildPlacementsSchema,
  EventSchema,
  PlacementOverrideSchema,
  SeatPlacementSchema,
} from "../src/index.js";
import { RUN, T0, events } from "./fixtures.js";
import { roundTrip } from "./helpers.js";

const placement = {
  seat: "critic",
  vendor: "claude",
  tier: "large",
  effort: "high",
  sources: { vendor: "single-vendor", tier: "role", effort: "role" },
  fresh: true,
  note: "A fresh agent takes the critic seat.",
};

describe("placements", () => {
  it("fills the defaults of a build's saved levels", () => {
    expect(roundTrip(BuildPlacementsSchema, {})).toEqual({
      singleVendor: null,
      plan: {},
      live: [],
    });
  });

  it("keeps a plan and live changes through a save", () => {
    const saved = {
      singleVendor: "claude",
      plan: { developer: { tier: "medium" } },
      live: [{ seat: "developer", placement: { effort: "high" }, at: T0 }],
    };
    expect(roundTrip(BuildPlacementsSchema, saved)).toEqual(saved);
  });

  it("rejects an unknown placement field", () => {
    expect(() => PlacementOverrideSchema.parse({ speed: "fast" })).toThrow(/speed/);
    expect(() => SeatPlacementSchema.parse({ ...placement, sources: { vendor: "box" } })).toThrow(
      /sources/,
    );
  });

  it("carries a placement on agent and lease events", () => {
    const started = events.find((e) => e.type === "agent.started");
    expect(EventSchema.parse({ ...started, placement })).toMatchObject({ placement });
    const settled = {
      ...started,
      type: "lease.settled",
      leaseId: "L1",
      runId: RUN,
      vendor: "claude",
      role: "fixer",
      tokens: { in: 1, out: 1 },
      premiumRequests: 0,
      costEstimate: 0,
      placement,
    };
    expect(EventSchema.parse(settled)).toMatchObject({ placement });
  });
});
