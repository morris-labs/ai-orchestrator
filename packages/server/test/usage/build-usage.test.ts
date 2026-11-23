import { EventSchema, type LeaseSettlement } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { T0, iso, setup } from "./helpers.js";

const RUN = "01JB8Z5K3W6Q2V9X4T7R0M1N2P";
const BUILD = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
const OTHER_BUILD = "01JB8Z5K3W6Q2V9X4T7R0M1N2R";

function settle(t: ReturnType<typeof setup>, n: number, fields: Partial<LeaseSettlement>) {
  t.usage.ingest(
    EventSchema.parse({
      id: `e${n}`,
      time: iso(T0),
      source: "engine:aio-agent-proj-example-app-1a2b3c4d",
      streamId: "S",
      seq: n,
      sourceSeq: n,
      type: "lease.settled",
      leaseId: `L${n}`,
      runId: null,
      vendor: "claude",
      role: "fixer",
      tokens: { in: 100, out: 10 },
      premiumRequests: 0,
      costEstimate: 0.5,
      ...fields,
    }),
  );
}

describe("usage by seat and by step", () => {
  it("sums one build's settled usage in total, by seat, and by step", () => {
    const t = setup();
    const build = { buildId: BUILD };
    settle(t, 1, { ...build, seat: "developer", step: "tasks" });
    settle(t, 2, { ...build, seat: "developer", step: "tasks", tokens: { in: 50, out: 5 } });
    settle(t, 3, {
      ...build,
      seat: "test-engineer",
      step: "tests_first",
      vendor: "codex",
      role: "reviewer",
      costEstimate: 0.25,
    });
    // A review run that the build started counts toward the build.
    settle(t, 4, { ...build, runId: RUN, seat: "developer", step: "review", premiumRequests: 1 });
    // Another build and a stand-alone review run don't.
    settle(t, 5, { buildId: OTHER_BUILD, seat: "developer", step: "tasks" });
    settle(t, 6, { runId: RUN });

    const usage = t.store.buildUsage(BUILD);
    const sum = (calls: number, tokensIn: number, tokensOut: number, p: number, cost: number) => ({
      calls,
      tokensIn,
      tokensOut,
      premiumRequests: p,
      costEstimate: cost,
    });
    expect(usage).toEqual({
      buildId: BUILD,
      total: sum(4, 350, 35, 1, 1.75),
      bySeat: [
        { seat: "developer", ...sum(3, 250, 25, 1, 1.5) },
        { seat: "test-engineer", ...sum(1, 100, 10, 0, 0.25) },
      ],
      // Steps in the order a milestone runs them.
      byStep: [
        { step: "tests_first", ...sum(1, 100, 10, 0, 0.25) },
        { step: "tasks", ...sum(2, 150, 15, 0, 1) },
        { step: "review", ...sum(1, 100, 10, 1, 0.5) },
      ],
    });
  });

  it("returns zero totals for a build with no settled calls", () => {
    const t = setup();
    expect(t.store.buildUsage(BUILD)).toEqual({
      buildId: BUILD,
      total: { calls: 0, tokensIn: 0, tokensOut: 0, premiumRequests: 0, costEstimate: 0 },
      bySeat: [],
      byStep: [],
    });
  });

  it("keeps a review run's settlement without a build", () => {
    const t = setup();
    settle(t, 1, { runId: RUN });
    expect(
      t.db.prepare("SELECT run_id, build_id, seat, step FROM svc_lease_settlements").all(),
    ).toEqual([{ run_id: RUN, build_id: null, seat: null, step: null }]);
  });
});
