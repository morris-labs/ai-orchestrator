import { describe, expect, it } from "vitest";
import {
  BuildUsageSchema,
  serverRoutes,
  EventSchema,
  LeaseRequestSchema,
  LeaseSettlementSchema,
} from "../src/index.js";
import { RUN, T0, T1, leaseRequest } from "./fixtures.js";
import { roundTrip } from "./helpers.js";

const BUILD = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
const CONTAINER = "aio-agent-proj-example-app-1a2b3c4d";
const meta = (seq: number) => ({
  id: `E-${seq}`,
  time: T0,
  source: `engine:${CONTAINER}`,
  streamId: "01JB8Z0000000000000000STRM",
  seq,
  sourceSeq: seq,
});

const build = {
  id: BUILD,
  slug: "add-export",
  projectId: "example-app-1a2b3c4d",
  container: CONTAINER,
  status: "running",
  step: "tasks",
  boxId: "example-app-1",
  createdAt: T0,
  updatedAt: T1,
};

const buildAgent = {
  runId: null,
  buildId: BUILD,
  seat: "developer",
  step: "tasks",
  agentId: `${BUILD}-A1`,
  leaseId: `${BUILD}-L1`,
  vendor: "claude",
  model: "claude-sonnet-5",
  role: "fixer",
  groupId: null,
  round: 1,
};

describe("build events", () => {
  it("parses a build.changed event", () => {
    const event = { ...meta(1), type: "build.changed", build };
    expect(roundTrip(EventSchema, event)).toEqual(event);
  });

  it("parses a build.task.changed event", () => {
    const event = {
      ...meta(2),
      type: "build.task.changed",
      buildId: BUILD,
      taskId: "T1",
      status: "running",
      previousStatus: "pending",
    };
    expect(roundTrip(EventSchema, event)).toEqual(event);
  });

  it("reads a build.changed event without a box as a build that no box runs", () => {
    const { boxId: _boxId, ...noBox } = build;
    const parsed = EventSchema.parse({ ...meta(1), type: "build.changed", build: noBox });
    expect(parsed).toMatchObject({ build: { boxId: null } });
  });

  it("rejects a build with a slug that isn't kebab case", () => {
    const event = { ...meta(1), type: "build.changed", build: { ...build, slug: "Add Export" } };
    expect(() => EventSchema.parse(event)).toThrow(/slug/);
  });

  it("names the build, seat, and step on a build's agent events", () => {
    const started = { ...meta(3), type: "agent.started", ...buildAgent };
    expect(roundTrip(EventSchema, started)).toEqual(started);
    const finished = {
      ...meta(4),
      type: "agent.finished",
      ...buildAgent,
      outcome: "ok",
      elapsedMs: 1000,
      tokens: { in: 10, out: 5 },
      premiumRequests: 0,
      costEstimate: 0,
    };
    expect(roundTrip(EventSchema, finished)).toEqual(finished);
  });

  it("rejects an unknown step and a seat that isn't kebab case", () => {
    const started = { ...meta(3), type: "agent.started", ...buildAgent };
    expect(() => EventSchema.parse({ ...started, step: "deploy" })).toThrow(/step/);
    expect(() => EventSchema.parse({ ...started, seat: "Test Engineer" })).toThrow(/seat/);
  });

  it("keeps a review run's agent event without build fields", () => {
    const review = { ...buildAgent, runId: RUN };
    delete (review as Partial<typeof review>).buildId;
    delete (review as Partial<typeof review>).seat;
    delete (review as Partial<typeof review>).step;
    const parsed = EventSchema.parse({ ...meta(5), type: "agent.started", ...review });
    expect(parsed).not.toHaveProperty("buildId");
    expect(parsed).not.toHaveProperty("seat");
    expect(parsed).not.toHaveProperty("step");
  });

  it("names the build, seat, and step on a build's lease request and settlement", () => {
    const owner = { runId: null, buildId: BUILD, seat: "developer", step: "tasks" };
    expect(roundTrip(LeaseRequestSchema, { ...leaseRequest, ...owner })).toMatchObject(owner);
    const settlement = {
      leaseId: "L-1",
      ...owner,
      vendor: "claude",
      role: "fixer",
      tokens: { in: 1, out: 1 },
      premiumRequests: 0,
      costEstimate: 0,
    };
    expect(roundTrip(LeaseSettlementSchema, settlement)).toEqual(settlement);
  });

  it("parses a build's usage by seat and by step", () => {
    const totals = { calls: 2, tokensIn: 30, tokensOut: 6, premiumRequests: 0, costEstimate: 0.1 };
    const usage = {
      buildId: BUILD,
      total: totals,
      bySeat: [{ seat: "developer", ...totals }],
      byStep: [
        { step: "tasks", ...totals },
        { step: null, ...totals },
      ],
      bySpecialty: [],
    };
    expect(roundTrip(BuildUsageSchema, usage)).toEqual(usage);
  });
});

describe("build routes", () => {
  it("lists builds, optionally for one project, and reads one build", () => {
    const list = serverRoutes["builds.list"];
    expect(list.method).toBe("GET");
    expect(list.path).toBe("/api/v1/builds");
    expect(list.query.parse({})).toEqual({});
    expect(list.query.parse({ projectId: "example-app-1a2b3c4d" }).projectId).toBe(
      "example-app-1a2b3c4d",
    );
    expect(roundTrip(list.response, { builds: [build] })).toEqual({ builds: [build] });
    const get = serverRoutes["builds.get"];
    expect(get.path).toBe("/api/v1/builds/:buildId");
    expect(roundTrip(get.response, build)).toEqual(build);
  });
});
