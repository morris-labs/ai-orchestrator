// The Project manager inbox: an item's pointer and whether it still waits.
import { describe, expect, it } from "vitest";
import { PmItemSchema, pmItemWaits, pmMarker, pmPointer, type PmItem } from "../src/index.js";

const item: PmItem = {
  id: "I3",
  kind: "digest",
  ref: "milestone-M1",
  summary: "Milestone M1 (Cart total) is done: 1 of 2 milestones.",
  file: "digests/milestone-M1.md",
  path: "/work/shop/.aio/builds/cart-total/digests/milestone-M1.md",
  needsAnswer: false,
  createdAt: "2026-11-23T09:00:00.000Z",
  deliveredAt: null,
  answeredAt: null,
};

describe("the Project manager inbox", () => {
  it("points to the item's file in one line that starts with its marker", () => {
    expect(pmMarker("cart-total", "I3")).toBe("[aio-build cart-total I3]");
    expect(pmPointer("cart-total", { ...item, summary: "Two\nlines" })).toBe(
      "[aio-build cart-total I3] Two lines Read /work/shop/.aio/builds/cart-total/digests/milestone-M1.md",
    );
  });

  it("waits until it's delivered and, when it needs one, answered", () => {
    const at = "2026-11-23T09:05:00.000Z";
    expect(pmItemWaits(item)).toBe(true);
    expect(pmItemWaits({ ...item, deliveredAt: at })).toBe(false);
    const escalation = { ...item, kind: "escalation" as const, needsAnswer: true, deliveredAt: at };
    expect(pmItemWaits(escalation)).toBe(true);
    expect(pmItemWaits({ ...escalation, answeredAt: at })).toBe(false);
  });

  it("refuses an item ID that isn't I and a number, and a summary over the limit", () => {
    expect(() => PmItemSchema.parse({ ...item, id: "E1" })).toThrow(/id/);
    expect(() => PmItemSchema.parse({ ...item, summary: "x".repeat(201) })).toThrow(/summary/);
  });
});
