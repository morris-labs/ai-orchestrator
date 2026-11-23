// Placements: the role default, the single-vendor setting, the build plan,
// and a live change, each overriding the one before it.
import { describe, expect, it } from "vitest";
import type { Placement } from "@aio/contracts";
import { PlacementError, resolvePlacement } from "../../src/build/placements/index.js";

const critic: Placement = { vendor: "codex", tier: "large", effort: "high" };

describe("resolvePlacement", () => {
  it("uses the role default when no other level sets anything", () => {
    expect(resolvePlacement({ seat: "critic", role: critic })).toEqual({
      seat: "critic",
      vendor: "codex",
      tier: "large",
      effort: "high",
      sources: { vendor: "role", tier: "role", effort: "role" },
      fresh: false,
    });
  });

  it("lets the single-vendor setting win over the role default", () => {
    const placed = resolvePlacement({ seat: "critic", role: critic, singleVendor: "claude" });

    expect(placed).toMatchObject({ vendor: "claude", tier: "large", effort: "high" });
    expect(placed.sources).toEqual({ vendor: "single-vendor", tier: "role", effort: "role" });
  });

  it("lets the build plan win over the single-vendor setting and the role default", () => {
    const placed = resolvePlacement({
      seat: "critic",
      role: critic,
      singleVendor: "claude",
      plan: { vendor: "claude", tier: "medium", effort: "low" },
    });

    expect(placed).toMatchObject({ vendor: "claude", tier: "medium", effort: "low" });
    expect(placed.sources).toEqual({ vendor: "plan", tier: "plan", effort: "plan" });
  });

  it("lets the plan move a seat to another vendor without the single-vendor setting", () => {
    const placed = resolvePlacement({ seat: "critic", role: critic, plan: { vendor: "claude" } });

    expect(placed).toMatchObject({ vendor: "claude", tier: "large", effort: "high" });
    expect(placed.sources).toEqual({ vendor: "plan", tier: "role", effort: "role" });
  });

  it("lets a live change win over the build plan", () => {
    const placed = resolvePlacement({
      seat: "critic",
      role: critic,
      plan: { tier: "medium", effort: "low" },
      live: { effort: "max" },
    });

    expect(placed).toMatchObject({ vendor: "codex", tier: "medium", effort: "max" });
    expect(placed.sources).toEqual({ vendor: "role", tier: "plan", effort: "live" });
  });

  it("refuses a plan or live vendor that breaks the single-vendor setting", () => {
    expect(() =>
      resolvePlacement({
        seat: "critic",
        role: critic,
        singleVendor: "claude",
        plan: { vendor: "codex" },
      }),
    ).toThrow(PlacementError);
    expect(() =>
      resolvePlacement({
        seat: "critic",
        role: critic,
        singleVendor: "claude",
        live: { vendor: "codex" },
      }),
    ).toThrow(/single-vendor setting places every seat on claude/);
  });

  it("uses a fresh agent on the same vendor when a rule requires another vendor", () => {
    const placed = resolvePlacement({
      seat: "critic",
      role: critic,
      singleVendor: "claude",
      otherThan: "claude",
    });

    expect(placed).toMatchObject({ vendor: "claude", fresh: true });
    expect(placed.note).toMatch(/fresh agent/);
  });

  it("keeps a seat that already differs from the vendor a rule excludes", () => {
    const placed = resolvePlacement({ seat: "critic", role: critic, otherThan: "claude" });

    expect(placed).toMatchObject({ vendor: "codex", fresh: false });
  });

  it("moves a seat on its role default off the vendor a rule excludes", () => {
    const placed = resolvePlacement({
      seat: "coverage-checker",
      role: { vendor: "claude", tier: "large", effort: "medium" },
      otherThan: "claude",
      movable: true,
    });

    expect(placed).toMatchObject({ vendor: "codex", tier: "large", fresh: false });
    expect(placed.note).toMatch(/requires a vendor other than claude/);
  });

  it("refuses a placement that breaks a rule requiring another vendor", () => {
    expect(() =>
      resolvePlacement({
        seat: "critic",
        role: critic,
        live: { vendor: "claude" },
        otherThan: "claude",
      }),
    ).toThrow(/requires a vendor other than claude/);
  });
});
