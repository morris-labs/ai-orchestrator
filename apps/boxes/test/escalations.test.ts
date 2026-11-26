// Which escalations the Builds area shows, and which ones notify the owner.
import { makeInboxItem } from "@aio/ui/testing";
import { describe, expect, it } from "vitest";
import { escalationsToNotify, openEscalations } from "../src/logic/escalations";

const B1 = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
const created = "2026-10-28T09:00:00Z";
const minutes = (n: number) => Date.parse(created) + n * 60_000;

describe("open escalations", () => {
  it("keeps the escalations that wait for delivery or for an answer", () => {
    const items = [
      makeInboxItem({ id: "I1", ref: "E1" }),
      makeInboxItem({ id: "I2", ref: "E2", deliveredAt: created }),
      makeInboxItem({ id: "I3", ref: "E3", deliveredAt: created, answeredAt: created }),
      makeInboxItem({ id: "I4", kind: "digest", ref: "milestone-M1", needsAnswer: false }),
    ];
    expect(openEscalations(items).map((i) => i.ref)).toEqual(["E1", "E2"]);
  });
});

describe("escalation notices", () => {
  const waiting = makeInboxItem({ id: "I1", ref: "E1", createdAt: created });
  const delivered = makeInboxItem({
    id: "I2",
    ref: "E2",
    createdAt: created,
    deliveredAt: created,
  });
  const open = new Map([[B1, [waiting, delivered]]]);

  it("waits two minutes for the pointer to reach the session", () => {
    expect(escalationsToNotify(open, new Set(), minutes(1))).toEqual([]);
    expect(escalationsToNotify(open, new Set(), minutes(2))).toEqual([
      { buildId: B1, item: waiting },
    ]);
  });

  it("skips an escalation it notified about already", () => {
    expect(escalationsToNotify(open, new Set([`${B1}/I1`]), minutes(5))).toEqual([]);
  });
});
