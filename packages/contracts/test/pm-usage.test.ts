import { describe, expect, it } from "vitest";
import {
  BUILD_SOCKET_SESSION_HEADERS,
  BuildUsageSchema,
  EVENT_TYPES,
  EventSchema,
  PM_SEAT,
  PmSessionSchema,
} from "../src/index.js";
import { T0, T1 } from "./fixtures.js";
import { roundTrip } from "./helpers.js";

const BUILD = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
const totals = { calls: 3, tokensIn: 900, tokensOut: 30, premiumRequests: 0, costEstimate: 0 };

describe("Project manager usage", () => {
  it("sends a tokens only seat's usage in a build.seat.usage event", () => {
    expect(EVENT_TYPES).toContain("build.seat.usage");
    const event = roundTrip(EventSchema, {
      id: "E-1",
      time: T1,
      source: "engine:aio-agent-proj-example-app-1a2b3c4d",
      streamId: "01JB8Z0000000000000000STRM",
      seq: 1,
      sourceSeq: 1,
      type: "build.seat.usage",
      buildId: BUILD,
      seat: PM_SEAT,
      turns: 3,
      tokensIn: 900,
      tokensOut: 30,
      since: T0,
      through: T1,
    });
    expect(event).toMatchObject({ type: "build.seat.usage", seat: "project-manager" });
  });

  it("marks a seat row of the usage by seat as tokens only", () => {
    const usage = roundTrip(BuildUsageSchema, {
      buildId: BUILD,
      total: totals,
      bySeat: [{ seat: PM_SEAT, ...totals, tokensOnly: true }, { seat: "developer", ...totals }],
      byStep: [],
      bySpecialty: [],
    });
    expect(usage.bySeat.map((r) => r.tokensOnly)).toEqual([true, undefined]);
  });

  it("names the session headers the aio-build command sends", () => {
    expect(BUILD_SOCKET_SESSION_HEADERS).toEqual({
      id: "x-aio-claude-session",
      transcripts: "x-aio-claude-transcripts",
    });
    expect(() =>
      PmSessionSchema.parse({ id: "../etc", transcripts: "/home/dev/.claude/projects", seenAt: T0 }),
    ).toThrow(/id/);
    expect(() =>
      PmSessionSchema.parse({ id: "8f1c2d3e-0000-4000-8000-000000000001", transcripts: "rel", seenAt: T0 }),
    ).toThrow(/transcripts/);
  });
});
