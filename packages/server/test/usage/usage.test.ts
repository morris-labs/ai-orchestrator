import { describe, expect, it } from "vitest";
import { UsageService } from "../../src/usage/usage-service.js";
import { MIN, T0, iso, setup } from "./helpers.js";

describe("account labels", () => {
  it("stores a legacy label under the vendor's default account", () => {
    const t = setup();
    t.sample("claude");
    t.settings.value = {
      ...t.settings.value,
      accountDefaults: { claude: "claude/personal" },
    };
    t.sample("claude");
    t.sample("claude", { account: "claude/work" });
    t.sample("codex", { account: "codex-default" });
    expect(t.store.accounts("claude")).toEqual([
      "claude/personal",
      "claude/work",
      "me@example.com",
    ]);
    expect(t.store.accounts("codex")).toEqual(["codex-default"]);
  });
});

describe("UsageStore", () => {
  it("filters samples by vendor and time, oldest first", () => {
    const t = setup();
    t.sample("claude", { utilization: 0.1 });
    t.clock.now += 10 * MIN;
    t.sample("codex", { utilization: 0.2 });
    t.clock.now += 10 * MIN;
    t.sample("claude", { utilization: 0.3 });
    expect(t.store.samples({ vendor: "claude" }).map((s) => s.utilization)).toEqual([0.1, 0.3]);
    expect(t.store.samples({ since: iso(T0 + 5 * MIN) }).map((s) => s.vendor)).toEqual([
      "codex",
      "claude",
    ]);
    expect(t.store.samples({ until: iso(T0 + 10 * MIN) })).toHaveLength(2);
    expect(t.store.accounts("claude")).toEqual(["me@example.com"]);
    expect(t.store.latest("claude", "5h")?.utilization).toBe(0.3);
  });

  it("records lease settlements", () => {
    const t = setup();
    t.usage.ingest(
      t.hub.emit({
        type: "lease.settled",
        leaseId: "L-1",
        runId: "01JB8Z5K3W6Q2V9X4T7R0M1N2P",
        vendor: "codex",
        role: "reviewer",
        tokens: { in: 10, out: 5 },
        premiumRequests: 0,
        costEstimate: 0.01,
      }),
    );
    const rows = t.db.prepare("SELECT lease_id FROM svc_lease_settlements").all();
    expect(rows).toEqual([{ lease_id: "L-1" }]);
  });
});

describe("UsageService", () => {
  it("emits ceiling.crossed above and below once per change", () => {
    const t = setup();
    t.sample("claude", { utilization: 0.5 });
    t.sample("claude", { utilization: 0.65 });
    t.sample("claude", { utilization: 0.7 });
    t.sample("claude", { utilization: 0.1 });
    const crossed = t.ofType("ceiling.crossed");
    expect(crossed.map((e) => e.direction)).toEqual(["above", "below"]);
    expect(crossed[0]).toMatchObject({ vendor: "claude", window: "5h", utilization: 0.65 });
  });

  it("does not re-emit after a restart that keeps the store", () => {
    const t = setup();
    t.sample("claude", { utilization: 0.9 });
    expect(t.ofType("ceiling.crossed")).toHaveLength(1);
    const restarted = new UsageService({
      store: t.store,
      settings: () => t.settings.value,
      emit: (e) => t.hub.emit(e),
      now: t.now,
    });
    restarted.ingest({ ...t.samples[0]!, utilization: 0.95 } as never);
    expect(t.ofType("ceiling.crossed")).toHaveLength(1);
  });

  it("ignores samples outside the ceiling's window", () => {
    const t = setup();
    t.sample("claude", { window: "7d", utilization: 0.99 });
    expect(t.ofType("ceiling.crossed")).toHaveLength(0);
    expect(t.usage.isOver("claude", t.settings.value.ceilings).over).toBe(false);
  });

  it("treats a sample whose reset time passed as reset", () => {
    const t = setup();
    t.sample("claude", { utilization: 0.9, resetAt: iso(T0 + 30 * MIN) });
    expect(t.usage.isOver("claude", t.settings.value.ceilings)).toMatchObject({ over: true });
    t.clock.now += 31 * MIN;
    expect(t.usage.isOver("claude", t.settings.value.ceilings)).toMatchObject({
      over: false,
      utilization: 0.9,
    });
  });

  it("compares a spend ceiling against spendUsd", () => {
    const t = setup();
    t.sample("copilot", { spendUsd: 69, utilization: 69 / 70, resetAt: null });
    expect(t.usage.isOver("copilot", t.settings.value.ceilings).over).toBe(false);
    t.sample("copilot", { spendUsd: 70, utilization: 1, resetAt: null });
    expect(t.usage.isOver("copilot", t.settings.value.ceilings).over).toBe(true);
    expect(t.ofType("ceiling.crossed")).toMatchObject([{ vendor: "copilot", window: "month" }]);
  });

  it("reports not over with no samples", () => {
    const t = setup();
    expect(t.usage.isOver("codex", t.settings.value.ceilings)).toEqual({
      over: false,
      resetAt: null,
      utilization: null,
    });
    expect(t.usage.forecast("codex", t.settings.value.ceilings)).toBeNull();
  });

  it("forecasts the ceiling with a linear fit over the last hour", () => {
    const t = setup();
    t.clock.now = T0 - 90 * MIN;
    t.sample("claude", { utilization: 0.0 }); // older than an hour: ignored
    t.clock.now = T0;
    t.sample("claude", { utilization: 0.1 });
    t.clock.now = T0 + 10 * MIN;
    t.sample("claude", { utilization: 0.2 });
    t.clock.now = T0 + 20 * MIN;
    t.sample("claude", { utilization: 0.3 });
    // 0.01 per minute from 0.1 at T0: 0.6 at T0 + 50 minutes.
    expect(t.usage.forecast("claude", t.settings.value.ceilings)).toBe(iso(T0 + 50 * MIN));
  });

  it("gives no forecast when usage is flat, over, or resets first", () => {
    const t = setup();
    t.sample("codex", { utilization: 0.2 });
    t.clock.now += 10 * MIN;
    t.sample("codex", { utilization: 0.2 });
    expect(t.usage.forecast("codex", t.settings.value.ceilings)).toBeNull();

    const resetSoon = iso(T0 + 30 * MIN);
    t.clock.now = T0;
    t.sample("claude", { utilization: 0.1, resetAt: resetSoon });
    t.clock.now = T0 + 10 * MIN;
    t.sample("claude", { utilization: 0.11, resetAt: resetSoon });
    expect(t.usage.forecast("claude", t.settings.value.ceilings)).toBeNull();

    t.sample("claude", { utilization: 0.7, resetAt: resetSoon });
    expect(t.usage.forecast("claude", t.settings.value.ceilings)).toBeNull();
  });

  it("uses only samples from the latest reset period", () => {
    const t = setup();
    t.sample("claude", { utilization: 0.5, resetAt: iso(T0 + 5 * MIN) });
    t.clock.now += 10 * MIN;
    t.sample("claude", { utilization: 0.05 });
    expect(t.usage.forecast("claude", t.settings.value.ceilings)).toBeNull();
    t.clock.now += 10 * MIN;
    t.sample("claude", { utilization: 0.15 });
    expect(t.usage.forecast("claude", t.settings.value.ceilings)).toBe(iso(T0 + 65 * MIN));
  });

  it("lists every vendor for usage.get", () => {
    const t = setup();
    t.sample("claude", { utilization: 0.7 });
    t.sample("claude", { window: "7d", utilization: 0.2 });
    const vendors = t.usage.vendors();
    expect(vendors.map((v) => [v.vendor, v.account])).toEqual([
      ["claude", "me@example.com"],
      ["codex", ""],
      ["copilot", ""],
    ]);
    expect(vendors[0]).toMatchObject({ overCeiling: true, window: "5h", forecastAt: null });
    expect(vendors[0]?.latest.map((s) => s.window)).toEqual(["5h", "7d"]);
    expect(vendors[2]).toMatchObject({ window: "month", latest: [], resetAt: null });
  });
});
