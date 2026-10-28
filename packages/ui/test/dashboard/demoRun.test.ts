import { EVENT_TYPES } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import { buildDemoEvents } from "../../src/testing/demoRun";

describe("the demo stream", () => {
  const events = buildDemoEvents();

  it("validates every line against the event schema", () => {
    expect(events.length).toBeGreaterThan(50);
  });

  it("covers every event type", () => {
    const seen = new Set(events.map((e) => e.type));
    expect(EVENT_TYPES.filter((t) => !seen.has(t))).toEqual([]);
  });

  it("numbers events from 1 without gaps in one stream", () => {
    expect(new Set(events.map((e) => e.streamId)).size).toBe(1);
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
  });

  it("keeps time moving forward", () => {
    for (let i = 1; i < events.length; i += 1) {
      expect(Date.parse(events[i]!.time)).toBeGreaterThanOrEqual(Date.parse(events[i - 1]!.time));
    }
  });
});
