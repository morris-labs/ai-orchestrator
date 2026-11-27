import { describe, expect, it } from "vitest";
import {
  BUILD_SOCKET_ROUTES,
  BuildMeetingRequestSchema,
  BuildPlanningSchema,
  MEETING_ROUND_CAP,
  MeetingReplySchema,
  majorObjections,
  meetingRoundCap,
} from "../src/index.js";

const reply = {
  position: "object",
  summary: "The design skips the empty cart.",
  points: [
    { severity: "major", point: "No task covers an empty cart.", reason: "AC1 needs it." },
    { severity: "minor", point: "The file name is vague.", reason: "cart.mjs holds more." },
  ],
};

describe("meeting replies", () => {
  it("accepts a reply with a position and a severity for each point", () => {
    expect(MeetingReplySchema.parse(reply)).toEqual(reply);
  });

  it("refuses a reply without a severity or with an unknown position", () => {
    expect(
      MeetingReplySchema.safeParse({ ...reply, points: [{ point: "x", reason: "y" }] }).success,
    ).toBe(false);
    expect(MeetingReplySchema.safeParse({ ...reply, position: "maybe" }).success).toBe(false);
  });

  it("refuses no objection that holds a major point", () => {
    const parsed = MeetingReplySchema.safeParse({ ...reply, position: "no_objection" });
    expect(parsed.success).toBe(false);
  });

  it("finds the major objections of a round", () => {
    expect(
      majorObjections([
        { seat: "critic", reply: MeetingReplySchema.parse(reply) },
        {
          seat: "analyst",
          reply: { position: "no_objection", summary: "Fine.", points: [] },
        },
      ]),
    ).toEqual([
      {
        seat: "critic",
        severity: "major",
        point: "No task covers an empty cart.",
        reason: "AC1 needs it.",
      },
    ]);
  });
});

describe("meeting requests", () => {
  it("defaults to the Architect proposing to the Critic, with no round cap of its own", () => {
    const request = BuildMeetingRequestSchema.parse({
      projectId: "proj-1",
      boxId: null,
      slug: "cart-total",
      brief: "Attack the design.",
    });
    expect(request).toMatchObject({ proposer: "architect", members: ["critic"] });
    expect(request.rounds).toBeUndefined();
  });

  it("caps a small or medium build's meeting at one round and a large build's at three", () => {
    expect(meetingRoundCap("small")).toBe(1);
    expect(meetingRoundCap("medium")).toBe(1);
    expect(meetingRoundCap("large")).toBe(MEETING_ROUND_CAP);
    expect(meetingRoundCap(undefined)).toBe(MEETING_ROUND_CAP);
  });

  it("refuses a proposer among the members", () => {
    expect(
      BuildMeetingRequestSchema.safeParse({
        projectId: "proj-1",
        boxId: null,
        slug: "cart-total",
        brief: "Attack the design.",
        members: ["architect"],
      }).success,
    ).toBe(false);
  });

  it("serves meetings on the build socket", () => {
    expect(BUILD_SOCKET_ROUTES.meet).toBe("/v1/builds/meet");
    expect(BUILD_SOCKET_ROUTES["meeting-post"]).toBe("/v1/builds/meeting-post");
  });

  it("reads a planning record written before meetings existed", () => {
    const record = BuildPlanningSchema.parse({
      version: 1,
      id: "01JC0000000000000000000000",
      slug: "cart-total",
      projectId: "proj-1",
      boxId: null,
      container: "aio-agent-proj-1",
      repoPath: "/work/shop",
      issue: null,
      calls: [],
      frozen: [],
      createdAt: "2026-11-23T10:00:00.000Z",
      updatedAt: "2026-11-23T10:00:00.000Z",
    });
    expect(record.meetings).toEqual([]);
  });
});
