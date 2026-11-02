// RunContext: the model a call uses, per tier, and the blocked models.
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type Vendor } from "@aio/contracts";
import type { AdapterRequest, ReviewOutput, VendorAdapter } from "../../src/core.js";
import { BridgedAdapter } from "../../src/adapters/bridge.js";
import { codexRolloutModel } from "../../src/adapters/codex.js";
import { AgentFailed } from "../../src/state/context.js";
import type { CoreDeps } from "../../src/api/core-interface.js";
import { parsePolicy } from "../../src/policy/load.js";
import { EngineRunManager } from "../../src/state/manager.js";
import { makeRun } from "./harness.js";

function recording(vendor: Vendor, reported?: string) {
  const models: Array<string | undefined> = [];
  const review = (req: AdapterRequest) => {
    models.push(req.model);
    return Promise.resolve({
      output: { findings: [], ledger: [] },
      model: reported ?? req.model ?? vendor,
      sessionId: null,
      tokens: { in: 1, out: 1 },
      usage: [],
      premiumRequests: 0,
      costEstimate: 0,
    });
  };
  return {
    models,
    adapter: { vendor, review, detectLimit: () => null } as unknown as VendorAdapter,
  };
}

const call = (vendor: Vendor, tier?: "small" | "medium" | "large") => ({
  key: `k-${vendor}-${tier ?? "none"}`,
  role: "reviewer" as const,
  vendor,
  method: "review" as const,
  request: { prompt: "p", repoPath: "/w", toolPolicy: "write" as const },
  groupId: null,
  estimateTokens: 1,
  ...(tier ? { tier: { tier, reason: "r", fixed: false } } : {}),
});

describe("the model of a call", () => {
  it("passes the tier's model per call", async () => {
    const claude = recording("claude");
    const { ctx } = await makeRun({ adapters: { claude: claude.adapter } });
    for (const tier of ["small", "medium", "large"] as const) {
      await ctx.callAgent<ReviewOutput>(call("claude", tier));
    }
    expect(claude.models).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
  });

  it("keeps the existing model for an unmapped vendor and records why", async () => {
    const codex = recording("codex");
    const { ctx, events } = await makeRun({
      adapters: { codex: codex.adapter },
      deps: { models: { codex: "gpt-6-sol" } },
    });
    await ctx.callAgent<ReviewOutput>(call("codex", "small"));
    expect(codex.models).toEqual(["gpt-6-sol"]);
    const started = events.events.find((e) => e.type === "agent.started") as {
      tierReason?: string;
    };
    expect(started.tierReason).toMatch(/no mapping for the small tier/);
  });

  it("uses a policy mapping", async () => {
    const codex = recording("codex");
    const { ctx } = await makeRun({ adapters: { codex: codex.adapter } });
    ctx.policy = { ...DEFAULT_POLICY, tierModels: { codex: { large: "gpt-6-sol" } } };
    await ctx.callAgent<ReviewOutput>(call("codex", "large"));
    expect(codex.models).toEqual(["gpt-6-sol"]);
  });

  it("never lets a tierless Claude call reach the CLI default", async () => {
    const claude = recording("claude");
    const { ctx } = await makeRun({ adapters: { claude: claude.adapter } });
    await ctx.callAgent<ReviewOutput>(call("claude"));
    expect(claude.models).toEqual(["claude-opus-5-5"]);
  });
});

describe("blocked models", () => {
  it("refuses a blocked per-vendor model when the manager starts", () => {
    expect(
      () => new EngineRunManager({ models: { codex: "gpt-6-astra" } } as unknown as CoreDeps),
    ).toThrow(/can't use/);
  });

  it("refuses a blocked model in a policy file", () => {
    expect(() => parsePolicy("version: 1\ntierModels:\n  claude:\n    large: Fable\n")).toThrow(
      /can't use the claude model Fable/,
    );
  });

  it.each([
    ["claude", "claude-fable-5-1"],
    ["codex", "gpt-6-ASTRA"],
  ] as const)("refuses %s %s from the per-vendor setting", async (vendor, model) => {
    const v = recording(vendor);
    const { ctx } = await makeRun({
      adapters: { [vendor]: v.adapter },
      deps: { models: { [vendor]: model } },
    });
    await expect(ctx.callAgent<ReviewOutput>(call(vendor))).rejects.toThrow(/can't use/);
    expect(v.models).toEqual([]);
  });

  it("refuses a blocked mapping that reached the context", async () => {
    const codex = recording("codex");
    const { ctx } = await makeRun({ adapters: { codex: codex.adapter } });
    ctx.policy = { ...DEFAULT_POLICY, tierModels: { codex: { large: "gpt-6-astra" } } };
    await expect(ctx.callAgent<ReviewOutput>(call("codex", "large"))).rejects.toBeInstanceOf(
      AgentFailed,
    );
    expect(codex.models).toEqual([]);
  });

  it("stops the run when the CLI reports a blocked default", async () => {
    const codex = recording("codex", "gpt-6-astra");
    const { ctx } = await makeRun({ adapters: { codex: codex.adapter } });
    await expect(ctx.callAgent<ReviewOutput>(call("codex"))).rejects.toThrow(/gpt-6-astra/);
  });

  it("refuses at the adapter bridge", async () => {
    const bridged = new BridgedAdapter({ vendor: "claude" } as never);
    await expect(
      bridged.review({
        prompt: "p",
        repoPath: "/w",
        toolPolicy: "read-only",
        timeoutMs: 1,
        model: "Fable",
      }),
    ).rejects.toThrow(/can't use/);
  });

  it("reads the model a Codex session used", () => {
    const line = JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } });
    expect(codexRolloutModel(`{"type":"other"}\n${line}\n{torn`)).toBe("gpt-6-astra");
    expect(codexRolloutModel("")).toBeNull();
  });
});
