// EventHub numbering and replay planning, and the lease broker without sockets.
import { describe, expect, it, vi } from "vitest";
import { EventHub } from "../../src/events/hub.js";
import { EngineLeaseBroker, LeaseBrokerClosedError } from "../../src/events/leases.js";
import { parseTypesFilter } from "../../src/events/stream.js";
import { silentLogger } from "../../src/main/logger.js";
import { CONTAINER, RUN } from "../api/fixtures.js";

const ports = { type: "ports.changed" as const, container: CONTAINER, listeners: [] };

describe("EventHub", () => {
  it("numbers events from 1 and fills the envelope", () => {
    const hub = new EventHub({ source: `engine:${CONTAINER}`, streamId: "s1" });
    const a = hub.emit(ports);
    const b = hub.emit(ports);
    expect([a.seq, b.seq, a.sourceSeq]).toEqual([1, 2, 1]);
    expect(a).toMatchObject({ source: `engine:${CONTAINER}`, streamId: "s1" });
    expect(hub.lastSeq).toBe(2);
  });

  it("rejects an invalid draft without using a number", () => {
    const hub = new EventHub({ source: "engine:c" });
    expect(() => hub.emit({ type: "ports.changed", container: "", listeners: [] })).toThrow();
    expect(hub.emit(ports).seq).toBe(1);
  });

  it("delivers to subscribers until they unsubscribe", () => {
    const hub = new EventHub({ source: "engine:c" });
    const seen = vi.fn();
    const off = hub.subscribe(seen);
    hub.emit(ports);
    off();
    hub.emit(ports);
    expect(seen).toHaveBeenCalledOnce();
  });

  it("plans a replay only for a matching stream the buffer still covers", () => {
    const hub = new EventHub({ source: "engine:c", streamId: "s1", capacity: 3 });
    for (let i = 0; i < 5; i++) hub.emit(ports);
    expect(hub.planReplay("s1", 3).events.map((e) => e.seq)).toEqual([4, 5]);
    expect(hub.planReplay("s1", 2)).toMatchObject({ replaying: true });
    expect(hub.planReplay("s1", 1)).toEqual({ replaying: false, events: [] });
    expect(hub.planReplay("s1", 5)).toEqual({ replaying: true, events: [] });
    expect(hub.planReplay("s1", 9)).toEqual({ replaying: false, events: [] });
    expect(hub.planReplay("other", 3)).toEqual({ replaying: false, events: [] });
    expect(hub.planReplay(null, null)).toEqual({ replaying: false, events: [] });
  });
});

describe("parseTypesFilter", () => {
  it("splits on commas and treats empty as all", () => {
    expect(parseTypesFilter(undefined)).toBeNull();
    expect(parseTypesFilter(" , ")).toBeNull();
    expect([...(parseTypesFilter("run.changed, ports.changed") ?? [])]).toEqual([
      "run.changed",
      "ports.changed",
    ]);
  });
});

describe("EngineLeaseBroker", () => {
  const ask = {
    runId: RUN,
    vendor: "claude" as const,
    role: "fixer" as const,
    estimate: { tokens: 10 },
  };
  let clock = Date.parse("2026-10-28T09:00:00Z");
  const now = () => new Date(clock);
  const make = (resendAfterMs = 30_000) => {
    const hub = new EventHub({ source: "engine:c" });
    let n = 0;
    const broker = new EngineLeaseBroker({
      log: silentLogger,
      now,
      newLeaseId: () => `L-${++n}`,
      resendAfterMs,
      tickMs: 60_000,
    });
    return { hub, broker };
  };
  const grant = (leaseId: string, expiresAt = "2026-10-28T10:00:00Z") => ({
    decision: "granted" as const,
    leaseId,
    vendor: "claude" as const,
    redirectedFrom: null,
    expiresAt,
  });

  it("holds a request until a server attaches, then sends it", async () => {
    const { broker } = make();
    const p = broker.request(ask);
    expect(broker.pendingIds()).toEqual(["L-1"]);
    const sent: unknown[] = [];
    broker.attach({ send: (f) => sent.push(f) });
    expect(sent).toEqual([{ type: "lease.request", leaseId: "L-1", ...ask }]);
    broker.handleResponse(grant("L-1"));
    await expect(p).resolves.toMatchObject({ decision: "granted", leaseId: "L-1" });
    expect(broker.pendingIds()).toEqual([]);
  });

  it("ignores a response for an unknown or settled lease", async () => {
    const { broker } = make();
    broker.attach({ send: () => {} });
    const p = broker.request(ask);
    broker.handleResponse(grant("L-1"));
    broker.handleResponse(grant("L-1"));
    broker.handleResponse(grant("L-9"));
    await expect(p).resolves.toMatchObject({ leaseId: "L-1" });
  });

  it("asks again under a new id when a grant arrives expired", async () => {
    const { broker } = make();
    const sent: { leaseId: string }[] = [];
    broker.attach({ send: (f) => sent.push(f) });
    const p = broker.request(ask);
    broker.handleResponse(grant("L-1", "2026-10-28T08:59:00Z"));
    expect(sent.map((f) => f.leaseId)).toEqual(["L-1", "L-2"]);
    broker.handleResponse(grant("L-2"));
    await expect(p).resolves.toMatchObject({ leaseId: "L-2" });
  });

  it("passes pause and deny answers through", async () => {
    const { broker } = make();
    broker.attach({ send: () => {} });
    const p = broker.request(ask);
    broker.handleResponse({
      decision: "pause",
      leaseId: "L-1",
      resumeAt: "2026-10-28T10:00:00Z",
      reason: "ceiling",
    });
    await expect(p).resolves.toMatchObject({ decision: "pause" });
    const q = broker.request(ask);
    broker.handleResponse({
      decision: "deny",
      leaseId: "L-2",
      reason: "cancelled",
      action: "fail_role",
    });
    await expect(q).resolves.toMatchObject({ decision: "deny" });
  });

  it("tells whether a grant is usable", () => {
    const { broker } = make();
    expect(broker.isUsable(grant("L-1", "2026-10-28T09:00:01Z"))).toBe(true);
    expect(broker.isUsable(grant("L-1", "2026-10-28T09:00:00Z"))).toBe(false);
  });

  it("resends a request that stays unanswered past the resend time", () => {
    const { broker } = make(1_000);
    const sent: string[] = [];
    broker.attach({ send: (f) => sent.push(f.leaseId) });
    broker.request(ask).catch(() => {});
    broker.resendStale();
    expect(sent).toEqual(["L-1"]);
    clock += 1_000;
    broker.resendStale();
    expect(sent).toEqual(["L-1", "L-1"]);
  });

  it("removes a request when its signal aborts", async () => {
    const { broker } = make();
    const ctrl = new AbortController();
    const p = broker.request(ask, { signal: ctrl.signal });
    ctrl.abort(new Error("run cancelled"));
    await expect(p).rejects.toThrow("run cancelled");
    expect(broker.pendingIds()).toEqual([]);
    await expect(broker.request(ask, { signal: ctrl.signal })).rejects.toThrow("run cancelled");
  });

  it("rejects pending and later requests once closed", async () => {
    const { broker } = make();
    const p = broker.request(ask);
    broker.close();
    await expect(p).rejects.toBeInstanceOf(LeaseBrokerClosedError);
    await expect(broker.request(ask)).rejects.toBeInstanceOf(LeaseBrokerClosedError);
  });

  it("settles a lease without an event, since the core emits lease.settled", () => {
    const { hub, broker } = make();
    const seen = vi.fn();
    hub.subscribe(seen);
    broker.settle("L-1", { tokens: { in: 5, out: 6 }, premiumRequests: 0, costEstimate: 0.01 });
    expect(seen).not.toHaveBeenCalled();
  });

  it("acquires a lease under the core's own lease id", async () => {
    const { broker } = make();
    const sent: unknown[] = [];
    broker.attach({ send: (frame) => sent.push(frame) });
    const p = broker.acquire({ ...ask, leaseId: "R-L1" });
    expect(sent).toEqual([expect.objectContaining({ type: "lease.request", leaseId: "R-L1" })]);
    broker.handleResponse(grant("R-L1"));
    await expect(p).resolves.toMatchObject({ decision: "granted", leaseId: "R-L1" });
  });

  it("survives a transport that throws", async () => {
    const { broker } = make();
    broker.attach({
      send: () => {
        throw new Error("socket gone");
      },
    });
    const p = broker.request(ask);
    broker.handleResponse(grant("L-1"));
    await expect(p).resolves.toMatchObject({ leaseId: "L-1" });
  });
});
