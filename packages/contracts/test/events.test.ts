import { describe, expect, it } from "vitest";
import { EVENT_TYPES, EventSchema } from "../src/index.js";
import { events } from "./fixtures.js";
import { roundTrip } from "./helpers.js";

describe("events", () => {
  it.each(events.map((e) => [e.type, e] as const))("parses a %s event", (_type, event) => {
    expect(roundTrip(EventSchema, event)).toMatchObject(event);
  });

  it("has a fixture for every event type", () => {
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(EVENT_TYPES));
  });

  it("lists the event types the plan names", () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        "agent.finished",
        "agent.started",
        "box.changed",
        "ceiling.crossed",
        "container.changed",
        "finding.changed",
        "handoff",
        "lease.requested",
        "notification",
        "ports.changed",
        "role.reassigned",
        "run.changed",
        "stage.changed",
        "terminal.ended",
        "usage.sample",
      ].sort(),
    );
  });

  it("rejects an unknown type", () => {
    const result = EventSchema.safeParse({ ...events[0], type: "agent.exploded" });
    expect(result.success).toBe(false);
  });

  it("rejects an event without the common fields", () => {
    const { seq: _seq, ...withoutSeq } = events[2]!;
    expect(EventSchema.safeParse(withoutSeq).success).toBe(false);
    expect(EventSchema.safeParse({ ...events[2], source: "elsewhere" }).success).toBe(false);
  });

  it("rejects a utilization above 1", () => {
    expect(EventSchema.safeParse({ ...events[5], utilization: 1.2 }).success).toBe(false);
  });
});
