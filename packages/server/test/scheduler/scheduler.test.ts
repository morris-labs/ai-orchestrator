import type { AioEvent, CeilingsOverride, LeaseRequest, Vendor } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import {
  ANNOUNCED_RUN_LIMIT,
  Scheduler,
  VendorHealth,
  mergeCeilings,
} from "../../src/scheduler/scheduler.js";
import { MIN, T0, iso, setup } from "../usage/helpers.js";

const RUN = "01JB8Z5K3W6Q2V9X4T7R0M1N2P";

function make(override?: CeilingsOverride, health?: VendorHealth) {
  const t = setup();
  const scheduler = new Scheduler({
    ...(health ? { usable: (runId: string, v: Vendor) => health.usable(runId, v) } : {}),
    usage: t.usage,
    settings: () => t.settings.value,
    projectCeilings: async () => override,
    runRound: () => 2,
    emit: (e) => t.hub.emit(e),
    now: t.now,
  });
  let n = 0;
  const req = (fields: Partial<LeaseRequest> = {}): LeaseRequest => ({
    leaseId: `L-${(n += 1)}`,
    runId: RUN,
    vendor: "codex",
    role: "reviewer",
    estimate: { tokens: 1000 },
    ...fields,
  });
  return { ...t, scheduler, req };
}

describe("Scheduler", () => {
  it("grants a vendor under its ceiling", async () => {
    const t = make();
    t.sample("codex", { utilization: 0.3 });
    const res = await t.scheduler.decide("engine:a", "p", t.req());
    expect(res).toEqual({
      decision: "granted",
      leaseId: "L-1",
      vendor: "codex",
      redirectedFrom: null,
      expiresAt: iso(T0 + 10 * MIN),
    });
  });

  it("treats a vendor as over when any of its accounts is over", async () => {
    const t = make();
    // Account A is over its ceiling; account B sampled after it and is not.
    t.sample("codex", { account: "codex/a", utilization: 0.98 });
    t.clock.now += MIN;
    t.sample("codex", { account: "codex/b", utilization: 0.1 });
    expect(await t.scheduler.decide("e", "p", t.req())).toMatchObject({
      decision: "granted",
      vendor: "copilot",
      redirectedFrom: "codex",
    });
    // The same answer when A sampled last.
    t.clock.now += MIN;
    t.sample("codex", { account: "codex/a", utilization: 0.98 });
    expect(await t.scheduler.decide("e", "p", t.req())).toMatchObject({ vendor: "copilot" });
  });

  it("redirects a role to the next vendor and announces it once", async () => {
    const t = make();
    t.sample("codex", { utilization: 0.8 });
    const first = await t.scheduler.decide("engine:a", "p", t.req({ role: "disprover" }));
    // codex -> copilot can't disprove -> claude.
    expect(first).toMatchObject({ decision: "granted", vendor: "claude", redirectedFrom: "codex" });
    await t.scheduler.decide("engine:a", "p", t.req({ role: "disprover" }));
    const moved = t.ofType("role.reassigned");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      runId: RUN,
      role: "disprover",
      from: ["codex"],
      to: ["claude"],
      reason: "ceiling",
      effectiveRound: 2,
    });
  });

  it("remembers announcements for a bounded number of runs", async () => {
    const t = make();
    t.sample("codex", { utilization: 0.8 });
    const decide = (runId: string) =>
      t.scheduler.decide("e", "p", t.req({ runId, role: "disprover" }));
    await decide(RUN);
    await decide(RUN);
    expect(t.ofType("role.reassigned")).toHaveLength(1);
    const ulid = (i: number) =>
      `01JB8Z5K3W6Q2V9X4T${[...i.toString(10).padStart(8, "0")].map((d) => "ABCDEFGHJK"[Number(d)]).join("")}`;
    for (let i = 0; i < ANNOUNCED_RUN_LIMIT; i += 1) await decide(ulid(i));
    // The first run was forgotten, so its move is announced again.
    await decide(RUN);
    expect(t.ofType("role.reassigned").filter((e) => e.runId === RUN)).toHaveLength(2);
  });

  it("redirects a reviewer to copilot first after codex", async () => {
    const t = make();
    t.sample("codex", { utilization: 0.8 });
    expect(await t.scheduler.decide("e", "p", t.req())).toMatchObject({ vendor: "copilot" });
  });

  it("emits no role.reassigned for a sweeper", async () => {
    const t = make();
    t.sample("codex", { utilization: 0.8 });
    const res = await t.scheduler.decide("e", "p", t.req({ role: "sweeper" }));
    expect(res).toMatchObject({ decision: "granted", vendor: "copilot" });
    expect(t.ofType("role.reassigned")).toHaveLength(0);
  });

  it("pauses the fixer until Claude's window resets", async () => {
    const t = make();
    const resetAt = iso(T0 + 42 * MIN);
    t.sample("claude", { utilization: 0.61, resetAt });
    const res = await t.scheduler.decide("e", "p", t.req({ vendor: "claude", role: "fixer" }));
    expect(res).toMatchObject({ decision: "pause", resumeAt: resetAt });
  });

  it("pauses the fixer for 15 minutes when the reset time is unknown", async () => {
    const t = make();
    t.sample("claude", { utilization: 0.61, resetAt: null });
    const res = await t.scheduler.decide("e", "p", t.req({ vendor: "claude", role: "fixer" }));
    expect(res).toMatchObject({ decision: "pause", resumeAt: iso(T0 + 15 * MIN) });
  });

  it("pauses until the earliest reset when no vendor can take the role", async () => {
    const t = make();
    t.sample("codex", { utilization: 0.9, resetAt: iso(T0 + 60 * MIN) });
    t.sample("claude", { utilization: 0.9, resetAt: iso(T0 + 20 * MIN) });
    const res = await t.scheduler.decide("e", "p", t.req({ role: "disprover" }));
    expect(res).toMatchObject({ decision: "pause", resumeAt: iso(T0 + 20 * MIN) });
  });

  it("denies when no vendor can take the role and no reset is known", async () => {
    const t = make();
    t.sample("codex", { utilization: 0.9, resetAt: null });
    const res = await t.scheduler.decide("e", "p", t.req({ role: "confirmer" }));
    expect(res).toMatchObject({ decision: "deny", action: "pause" });
  });

  it("counts a zero ceiling with no sample as over", async () => {
    const t = make();
    t.settings.value = {
      ...t.settings.value,
      ceilings: {
        ...t.settings.value.ceilings,
        copilot: { kind: "spend", period: "month", maxUsd: 0 },
      },
    };
    t.sample("codex", { utilization: 0.8, resetAt: iso(T0 + 30 * MIN) });
    const res = await t.scheduler.decide("e", "p", t.req());
    // codex is over and copilot's $0 ceiling keeps it out, so claude reviews.
    expect(res).toMatchObject({ decision: "granted", vendor: "claude" });
  });

  it("skips a vendor that failed earlier in the run", async () => {
    const health = new VendorHealth();
    const finished = (vendor: Vendor, outcome: "ok" | "error") =>
      ({ type: "agent.finished", runId: RUN, vendor, outcome }) as unknown as AioEvent;
    health.ingest(finished("copilot", "error"));
    const t = make(undefined, health);
    t.sample("codex", { utilization: 0.8 });
    expect(await t.scheduler.decide("e", "p", t.req())).toMatchObject({ vendor: "claude" });
    expect(health.usable("01JB8Z5K3W6Q2V9X4T7R0M1N2Q", "copilot")).toBe(true);
    health.ingest(finished("copilot", "ok"));
    expect(health.usable(RUN, "copilot")).toBe(true);
  });

  it("pauses with a clear reason instead of picking a failing vendor", async () => {
    const health = new VendorHealth();
    for (const vendor of ["copilot", "claude"] as const)
      health.ingest({
        type: "agent.finished",
        runId: RUN,
        vendor,
        outcome: "error",
      } as unknown as AioEvent);
    const t = make(undefined, health);
    t.sample("codex", { utilization: 0.8, resetAt: iso(T0 + 30 * MIN) });
    const res = await t.scheduler.decide("e", "p", t.req());
    expect(res).toMatchObject({ decision: "pause", resumeAt: iso(T0 + 30 * MIN) });
    expect(res.decision === "pause" && res.reason).toMatch(/copilot and claude failed earlier/);
    const t2 = make(undefined, health);
    t2.sample("codex", { utilization: 0.8, resetAt: null });
    expect(await t2.scheduler.decide("e", "p", t2.req())).toMatchObject({
      decision: "deny",
      action: "pause",
    });
  });

  it("answers a repeated leaseId with the same response", async () => {
    const t = make();
    t.sample("codex", { utilization: 0.1 });
    const req = t.req();
    const first = await t.scheduler.decide("e", "p", req);
    t.sample("codex", { utilization: 0.9 });
    t.clock.now += MIN;
    expect(await t.scheduler.decide("e", "p", req)).toEqual(first);
    // Another engine with the same lease id gets its own answer.
    expect(await t.scheduler.decide("f", "p", req)).toMatchObject({ vendor: "copilot" });
    t.scheduler.forget("e");
    expect(await t.scheduler.decide("e", "p", req)).toMatchObject({ vendor: "copilot" });
  });

  it("answers a repeated leaseId afresh once its grant or pause has expired", async () => {
    const t = make();
    t.sample("codex", { utilization: 0.1 });
    const req = t.req();
    const first = await t.scheduler.decide("e", "p", req);
    expect(first).toMatchObject({ decision: "granted", vendor: "codex" });
    t.sample("codex", { utilization: 0.9 });
    t.clock.now += 11 * MIN;
    expect(await t.scheduler.decide("e", "p", req)).toMatchObject({ vendor: "copilot" });

    t.sample("claude", { utilization: 0.95, resetAt: iso(t.clock.now + 5 * MIN) });
    const fix = t.req({ vendor: "claude", role: "fixer" });
    expect(await t.scheduler.decide("e", "p", fix)).toMatchObject({ decision: "pause" });
    t.clock.now += 6 * MIN;
    t.sample("claude", { utilization: 0.1, resetAt: null });
    expect(await t.scheduler.decide("e", "p", fix)).toMatchObject({ decision: "granted" });
  });

  it("applies the project's ceiling override", async () => {
    const t = make({ codex: { kind: "utilization", window: "5h", max: 0.2 } });
    t.sample("codex", { utilization: 0.3 });
    expect(await t.scheduler.decide("e", "p", t.req())).toMatchObject({ vendor: "copilot" });
  });

  it("merges an override per vendor", () => {
    const t = setup();
    const merged = mergeCeilings(t.settings.value.ceilings, {
      copilot: { kind: "spend", period: "month", maxUsd: 5 },
    });
    expect(merged.copilot).toEqual({ kind: "spend", period: "month", maxUsd: 5 });
    expect(merged.claude).toEqual(t.settings.value.ceilings.claude);
  });
});
