import { describe, expect, it } from "vitest";
import {
  ClientHelloSchema,
  EVENT_TYPES,
  EngineStreamClientFrameSchema,
  EngineStreamFrameSchema,
  EventSchema,
  ServerStreamFrameSchema,
} from "../src/index.js";
import { events, leaseRequest, leaseResponses } from "./fixtures.js";
import { roundTrip } from "./helpers.js";

describe("events", () => {
  it.each(events.map((e) => [e.type, e] as const))("parses a %s event", (_type, event) => {
    expect(roundTrip(EventSchema, event)).toMatchObject(event);
  });

  it("has a fixture for every event type", () => {
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(EVENT_TYPES));
  });

  it("lists the agreed event types", () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        "agent.finished",
        "agent.started",
        "box.changed",
        "build.changed",
        "build.task.changed",
        "ceiling.crossed",
        "container.changed",
        "container.stats",
        "finding.changed",
        "handoff",
        "lease.settled",
        "notification",
        "ports.changed",
        "role.reassigned",
        "run.changed",
        "settings.changed",
        "stage.changed",
        "terminal.ended",
        "usage.sample",
      ].sort(),
    );
  });

  it("rejects an unknown type, including the retired lease.requested", () => {
    expect(EventSchema.safeParse({ ...events[0], type: "agent.exploded" }).success).toBe(false);
    expect(
      EventSchema.safeParse({ ...events[0], type: "lease.requested", ...leaseRequest }).success,
    ).toBe(false);
  });

  it("rejects an event without the common fields", () => {
    for (const key of ["seq", "sourceSeq", "streamId"] as const) {
      const { [key]: _omitted, ...rest } = events[2]!;
      expect(EventSchema.safeParse(rest).success, key).toBe(false);
    }
    expect(EventSchema.safeParse({ ...events[2], source: "elsewhere" }).success).toBe(false);
    expect(EventSchema.safeParse({ ...events[2], seq: 0 }).success).toBe(false);
  });

  it("allows a utilization above 1 but not below 0", () => {
    expect(EventSchema.safeParse({ ...events[5], utilization: 1.2 }).success).toBe(true);
    expect(EventSchema.safeParse({ ...events[5], utilization: -0.1 }).success).toBe(false);
  });

  it("keeps the stream source on a usage sample apart from the sample source", () => {
    const parsed = EventSchema.parse(events[5]);
    expect(parsed).toMatchObject({ source: events[5]!.source, sampleSource: "rate_limit_event" });
    expect(EventSchema.safeParse({ ...events[5], source: "rate_limit_event" }).success).toBe(false);
    const { sampleSource: _s, ...withoutSampleSource } = events[5] as Record<string, unknown>;
    expect(EventSchema.safeParse(withoutSampleSource).success).toBe(false);
  });

  it("accepts optional AI credits on a finished agent", () => {
    expect(EventSchema.parse({ ...events[1], aiCredits: 2 })).toMatchObject({ aiCredits: 2 });
    expect(EventSchema.parse(events[1])).not.toHaveProperty("aiCredits");
    expect(EventSchema.safeParse({ ...events[1], aiCredits: -1 }).success).toBe(false);
  });

  it("requires the ceiling on every usage sample", () => {
    const { ceiling: _c, ...withoutCeiling } = events[5] as Record<string, unknown>;
    expect(EventSchema.safeParse(withoutCeiling).success).toBe(false);
  });
});

describe("stream frames", () => {
  const hello = { type: "hello", streamId: "S1", lastSeq: 17, replaying: false };

  it("lets the server stream carry hello frames and events but not lease requests", () => {
    expect(ServerStreamFrameSchema.parse(hello).type).toBe("hello");
    expect(ServerStreamFrameSchema.parse(events[0]).type).toBe("agent.started");
    expect(
      ServerStreamFrameSchema.safeParse({ type: "lease.request", ...leaseRequest }).success,
    ).toBe(false);
  });

  it("lets the engine stream carry lease requests", () => {
    expect(EngineStreamFrameSchema.parse({ type: "lease.request", ...leaseRequest }).type).toBe(
      "lease.request",
    );
    expect(EngineStreamFrameSchema.parse(hello).type).toBe("hello");
  });

  it("accepts the server's hello and lease responses on the engine stream", () => {
    expect(ClientHelloSchema.parse({ type: "hello", streamId: null, lastSeq: null })).toBeTruthy();
    expect(
      EngineStreamClientFrameSchema.parse({ type: "hello", streamId: "S1", lastSeq: 4 }).type,
    ).toBe("hello");
    expect(
      EngineStreamClientFrameSchema.parse({ type: "lease.response", response: leaseResponses[2] })
        .type,
    ).toBe("lease.response");
    expect(EngineStreamClientFrameSchema.safeParse(events[0]).success).toBe(false);
  });
});
