// Placed agent calls: a build's seats run on their placements through the
// shared agent-call core.
import { describe, expect, it } from "vitest";
import type { LeaseRequest, LeaseResponse, Placement } from "@aio/contracts";
import { GrantingBroker, type EventDraft } from "../../src/core.js";
import { DecisionNeeded } from "../../src/calls/index.js";
import { PlacementError, SeatPlacements, placeCall } from "../../src/build/placements/index.js";
import { buildSampleRepo } from "../state/scenario.js";
import { answering, gated, limited, makeCaller, spec, type Answer } from "../calls/caller.js";

const roles = new Map<string, { placement: Placement }>([
  ["developer", { placement: { vendor: "claude", tier: "large", effort: "medium" } }],
  ["critic", { placement: { vendor: "codex", tier: "large", effort: "high" } }],
]);

type Started = Extract<EventDraft, { type: "agent.started" }>;
type Finished = Extract<EventDraft, { type: "agent.finished" }>;
type Settled = Extract<EventDraft, { type: "lease.settled" }>;

function ofType<T extends EventDraft["type"]>(events: EventDraft[], type: T) {
  return events.filter((e): e is Extract<EventDraft, { type: T }> => e.type === type);
}

/** A broker that moves every grant to Codex, as a server over a Claude ceiling might. */
class RedirectingBroker extends GrantingBroker {
  override acquire(request: LeaseRequest): Promise<LeaseResponse> {
    this.requests.push(request);
    return Promise.resolve({
      decision: "granted",
      leaseId: request.leaseId,
      vendor: "codex",
      redirectedFrom: request.vendor,
      expiresAt: "2026-10-28T09:10:00.000Z",
    });
  }
}

describe("placed agent calls", () => {
  it("shows the placement that ran on agent and usage events", async () => {
    const repo = buildSampleRepo();
    const seats = new SeatPlacements(roles, { plan: { critic: { tier: "medium" } } });
    const { calls, emitted } = makeCaller({ codex: answering("codex") });

    const placement = seats.place("critic");
    await calls.call<Answer>(placeCall(spec(repo), placement));

    const expected = {
      seat: "critic",
      vendor: "codex",
      tier: "medium",
      effort: "high",
      sources: { vendor: "role", tier: "plan", effort: "role" },
      fresh: false,
    };
    const started = ofType(emitted, "agent.started")[0] as Started;
    const finished = ofType(emitted, "agent.finished")[0] as Finished;
    const settled = ofType(emitted, "lease.settled")[0] as Settled;
    expect(started.placement).toEqual(expected);
    expect(started).toMatchObject({ vendor: "codex", tier: "medium", effort: "high" });
    expect(finished.placement).toEqual(expected);
    expect(settled.placement).toEqual(expected);
  });

  it("applies a live change to the next agent, not to the one running", async () => {
    const repo = buildSampleRepo();
    const seats = new SeatPlacements(roles, {});
    const codex = gated("codex");
    const { calls, emitted } = makeCaller({ codex });

    const running = calls.call<Answer>(
      placeCall(spec(repo, { key: "turn-1" }), seats.place("critic")),
    );
    await codex.started;
    seats.change("critic", { effort: "max" }, "2026-10-28T09:01:00.000Z");
    codex.release();
    await running;
    await calls.call<Answer>(placeCall(spec(repo, { key: "turn-2" }), seats.place("critic")));

    const finished = ofType(emitted, "agent.finished");
    expect(finished.map((e) => e.placement?.effort)).toEqual(["high", "max"]);
    expect(finished.map((e) => e.effort)).toEqual(["high", "max"]);
    expect(finished[1]?.placement?.sources.effort).toBe("live");
    expect(seats.state().live).toEqual([
      { seat: "critic", placement: { effort: "max" }, at: "2026-10-28T09:01:00.000Z" },
    ]);
  });

  it("refuses a live change that breaks the single-vendor setting", () => {
    const seats = new SeatPlacements(roles, { singleVendor: "claude" });

    expect(() => seats.change("critic", { vendor: "codex" })).toThrow(PlacementError);
    expect(seats.state().live).toEqual([]);
  });

  it("makes no call to the other vendor with the single-vendor setting", async () => {
    const repo = buildSampleRepo();
    const seats = new SeatPlacements(roles, { singleVendor: "claude" });
    const codex = answering("codex");
    const { calls, broker } = makeCaller({ claude: answering("claude"), codex });

    const critic = await calls.call<Answer>(
      placeCall(spec(repo, { key: "critic" }), seats.place("critic", { otherThan: "claude" })),
    );

    expect(critic.vendor).toBe("claude");
    expect(codex.calls).toBe(0);
    expect(broker.requests.map((r) => r.vendor)).toEqual(["claude"]);
    // The server must not move the call to another vendor either.
    expect(broker.requests[0]?.exclude).toEqual(["codex", "copilot"]);
  });

  it("waits instead of moving to the other vendor when the single vendor hits a limit", async () => {
    const repo = buildSampleRepo();
    const seats = new SeatPlacements(roles, { singleVendor: "claude" });
    const codex = answering("codex");
    const { calls } = makeCaller({ claude: limited("claude"), codex });

    await expect(
      calls.call<Answer>(placeCall(spec(repo), seats.place("developer"))),
    ).rejects.toBeInstanceOf(DecisionNeeded);
    expect(codex.calls).toBe(0);
  });

  it("refuses a server grant on the other vendor with the single-vendor setting", async () => {
    const repo = buildSampleRepo();
    const seats = new SeatPlacements(roles, { singleVendor: "claude" });
    const codex = answering("codex");
    const { calls, broker } = makeCaller(
      { claude: answering("claude"), codex },
      undefined,
      () => new RedirectingBroker(),
    );

    await expect(
      calls.call<Answer>(placeCall(spec(repo), seats.place("developer"))),
    ).rejects.toBeInstanceOf(DecisionNeeded);
    expect(codex.calls).toBe(0);
    expect(broker.settled).toHaveLength(1);
  });

  it("starts a fresh session when a rule needs another vendor on a single-vendor build", () => {
    const seats = new SeatPlacements(roles, { singleVendor: "claude" });

    const placed = placeCall(
      spec("/repo", {
        request: { prompt: "Check.", repoPath: "/repo", toolPolicy: "read-only", sessionId: "s-1" },
      }),
      seats.place("critic", { otherThan: "claude" }),
    );

    expect(placed.vendor).toBe("claude");
    expect(placed.request.sessionId).toBeUndefined();
    expect(placed.placement?.fresh).toBe(true);
  });
});
