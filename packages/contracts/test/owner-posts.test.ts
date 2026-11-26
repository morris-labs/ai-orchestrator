import { describe, expect, it } from "vitest";
import {
  BuildDecisionSchema,
  BuildPlanSchema,
  OwnerPostSchema,
  OwnerPostTurnAnswerSchema,
} from "../src/index.js";
import { T0 } from "./fixtures.js";
import { roundTrip } from "./helpers.js";

const BUILD = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";

const decision = {
  version: 1,
  id: "D1",
  buildId: BUILD,
  messageId: "M4",
  to: { kind: "seat", seat: "developer", taskId: "T1" },
  taskId: "T1",
  milestone: null,
  body: "Round the total to whole cents.",
  createdAt: T0,
  planChange: null,
};

describe("owner posts", () => {
  it("parses a post to an agent and defaults its type to a note", () => {
    expect(
      OwnerPostSchema.parse({ to: "developer", toTask: "T1", body: "Round to cents." }),
    ).toEqual({ to: "developer", toTask: "T1", body: "Round to cents.", type: "note" });
  });

  it("refuses a post addressed to the owner", () => {
    expect(() => OwnerPostSchema.parse({ to: "owner", body: "Hello." })).toThrow(
      /an owner post goes to a seat/,
    );
  });

  it("refuses a post without an addressee or a sender field", () => {
    expect(() => OwnerPostSchema.parse({ body: "Hello." })).toThrow(/to/);
    expect(() =>
      OwnerPostSchema.parse({ to: "developer", body: "Hello.", from: "developer" }),
    ).toThrow(/from/);
  });

  it("parses a decision record, with and without a plan change flag", () => {
    expect(roundTrip(BuildDecisionSchema, decision)).toEqual(decision);
    const flagged = {
      ...decision,
      planChange: {
        criteria: ["AC1"],
        reason: "AC1 asks for exact sums.",
        reportedBy: { kind: "seat", seat: "developer", taskId: "T1" },
        messageId: "M5",
        flaggedAt: T0,
      },
    };
    expect(roundTrip(BuildDecisionSchema, flagged)).toEqual(flagged);
    expect(() =>
      BuildDecisionSchema.parse({
        ...flagged,
        planChange: { ...flagged.planChange, criteria: [] },
      }),
    ).toThrow(/criteria/);
  });

  it("reads an owner post turn's answer with an empty contradiction list by default", () => {
    expect(OwnerPostTurnAnswerSchema.parse({ summary: "Done." })).toEqual({
      summary: "Done.",
      contradicts: [],
    });
  });

  it("lets a plan set the direct messages per milestone", () => {
    const plan = {
      title: "Cart",
      criteria: [{ id: "AC1", text: "Sums." }],
      tasks: [
        {
          id: "T1",
          title: "Total",
          description: "Sum.",
          ownedFiles: ["src/cart.mjs"],
          criteria: ["AC1"],
        },
      ],
      commands: { test: [{ command: "node test.mjs" }] },
    };
    expect(BuildPlanSchema.parse(plan).directMessagesPerMilestone).toBeUndefined();
    expect(
      BuildPlanSchema.parse({ ...plan, directMessagesPerMilestone: 0 }).directMessagesPerMilestone,
    ).toBe(0);
    expect(() => BuildPlanSchema.parse({ ...plan, directMessagesPerMilestone: -1 })).toThrow();
  });
});
