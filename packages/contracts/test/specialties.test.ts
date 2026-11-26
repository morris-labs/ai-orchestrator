import { describe, expect, it } from "vitest";
import {
  BuildUsageSchema,
  EventSchema,
  LeaseSettlementSchema,
  SPECIALTIES_DIR,
  SpecialtyNameSchema,
  TaskSpecialtiesSchema,
} from "../src/index.js";
import { T0 } from "./fixtures.js";
import { roundTrip } from "./helpers.js";

const BUILD = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
const owner = {
  runId: null,
  buildId: BUILD,
  seat: "developer",
  step: "tasks",
  specialties: ["node-dev", "typescript-dev"],
};

describe("specialties", () => {
  it("keeps repository specialties in the team directory", () => {
    expect(SPECIALTIES_DIR).toBe(".aio/team/specialties");
  });

  it("accepts a skill-style name and rejects a path", () => {
    expect(SpecialtyNameSchema.parse("typescript-dev")).toBe("typescript-dev");
    expect(() => SpecialtyNameSchema.parse("../secrets")).toThrow();
    expect(() => SpecialtyNameSchema.parse("Node.js")).toThrow();
  });

  it("defaults a task's specialties to none and refuses a repeat", () => {
    expect(TaskSpecialtiesSchema.parse(undefined)).toEqual([]);
    expect(() => TaskSpecialtiesSchema.parse(["go-dev", "go-dev"])).toThrow(/go-dev/);
  });

  it("names a build call's specialties on its settlement and agent events", () => {
    const settlement = {
      leaseId: "L-1",
      ...owner,
      vendor: "codex",
      role: "fixer",
      tokens: { in: 1, out: 1 },
      premiumRequests: 0,
      costEstimate: 0,
    };
    expect(roundTrip(LeaseSettlementSchema, settlement)).toEqual(settlement);
    const started = {
      id: "E-1",
      time: T0,
      source: "engine:aio-agent-proj-example-app-1a2b3c4d",
      streamId: "01JB8Z0000000000000000STRM",
      seq: 1,
      sourceSeq: 1,
      type: "agent.started",
      ...owner,
      agentId: `${BUILD}-A1`,
      leaseId: `${BUILD}-L1`,
      vendor: "codex",
      model: "codex-model",
      role: "fixer",
      groupId: null,
      round: 1,
    };
    expect(roundTrip(EventSchema, started)).toEqual(started);
  });

  it("parses a build's usage by specialty", () => {
    const totals = { calls: 1, tokensIn: 3, tokensOut: 1, premiumRequests: 0, costEstimate: 0 };
    const usage = {
      buildId: BUILD,
      total: totals,
      bySeat: [],
      byStep: [],
      bySpecialty: [
        { specialty: "go-dev", ...totals },
        { specialty: null, ...totals },
      ],
    };
    expect(roundTrip(BuildUsageSchema, usage)).toEqual(usage);
  });
});
