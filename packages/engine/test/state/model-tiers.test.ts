// RunContext: the model a call uses, per tier, and the blocked models.
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_POLICY,
  isBlockedRequestedModel,
  isBlockedReviewModel,
  type Finding,
  type Vendor,
} from "@aio/contracts";
import type { AdapterRequest, ReviewOutput, VendorAdapter } from "../../src/core.js";
import { BridgedAdapter } from "../../src/adapters/bridge.js";
import { codexRolloutModel } from "../../src/adapters/codex.js";
import { AgentFailed } from "../../src/state/context.js";
import type { CoreDeps } from "../../src/api/core-interface.js";
import { parsePolicy } from "../../src/policy/load.js";
import { EngineRunManager } from "../../src/state/manager.js";
import { callTier } from "../../src/state/steps.js";
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
    const copilot = recording("copilot");
    const { ctx, events } = await makeRun({ adapters: { copilot: copilot.adapter } });
    await ctx.callAgent<ReviewOutput>(call("copilot", "small"));
    expect(copilot.models).toEqual([undefined]);
    const started = events.events.find((e) => e.type === "agent.started") as {
      tierReason?: string;
    };
    expect(started.tierReason).toMatch(/no mapping for the small tier/);
  });

  it("passes the Codex tier models", async () => {
    const codex = recording("codex");
    const { ctx } = await makeRun({ adapters: { codex: codex.adapter } });
    for (const tier of ["small", "medium", "large"] as const) {
      await ctx.callAgent<ReviewOutput>(call("codex", tier));
    }
    expect(codex.models).toEqual(["gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"]);
  });

  it("never lets a tierless Codex call reach the CLI default", async () => {
    const codex = recording("codex");
    const { ctx } = await makeRun({ adapters: { codex: codex.adapter } });
    await ctx.callAgent<ReviewOutput>(call("codex"));
    expect(codex.models).toEqual(["gpt-6.1-sol"]);
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
    // The backstop: the CLI answered with a blocked model despite the request.
    const codex = recording("codex", "gpt-6-astra");
    const { ctx } = await makeRun({ adapters: { codex: codex.adapter } });
    await expect(ctx.callAgent<ReviewOutput>(call("codex"))).rejects.toThrow(/gpt-6-astra/);
  });

  it("marks the call as an error before it stops the run", async () => {
    const claude = recording("claude", "claude-fable-5-1");
    const { ctx, events } = await makeRun({ adapters: { claude: claude.adapter } });
    await expect(ctx.callAgent<ReviewOutput>(call("claude", "large"))).rejects.toBeInstanceOf(
      AgentFailed,
    );
    expect(events.ofType("agent.finished").at(-1)?.outcome).toBe("error");
  });

  it("takes a write call's commits back when it used a blocked model", async () => {
    const claude = recording("claude", "claude-fable-5-1");
    const { ctx } = await makeRun({ adapters: { claude: claude.adapter } });
    const head = vi
      .spyOn(ctx.git, "head")
      .mockResolvedValueOnce("a".repeat(40))
      .mockResolvedValue("b".repeat(40));
    const reset = vi.spyOn(ctx.git, "resetKeep").mockResolvedValue();
    await expect(ctx.callAgent<ReviewOutput>(call("claude", "large"))).rejects.toThrow(
      /moved the branch back/,
    );
    expect(head).toHaveBeenCalled();
    expect(reset).toHaveBeenCalledWith("a".repeat(40));
  });

  it("names a blocked model through Copilot, but leaves automatic selection alone", () => {
    expect(isBlockedRequestedModel("copilot", "claude-fable-5-1")).toBe(true);
    expect(isBlockedRequestedModel("copilot", "auto")).toBe(false);
    expect(isBlockedReviewModel("copilot", "claude-fable-5-1")).toBe(false);
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

describe("call tiers and persisting findings", () => {
  const group = {
    id: "G01",
    files: ["a.ts"],
    kind: "minor" as const,
    changedLines: 1,
    riskPath: false,
    hunks: [],
    tier: "medium" as const,
    tierReason: "r",
  };
  const finding = (patch: Partial<Finding>): Finding =>
    ({
      id: "F-1",
      severity: "P2",
      verdict: "confirmed",
      round: 1,
      file: "a.ts",
      ...patch,
    }) as Finding;

  async function tierWith(f: Finding, readOnly = false) {
    const { ctx } = await makeRun({ adapters: { claude: recording("claude").adapter } });
    ctx.state.request.modelTier = "auto";
    ctx.state.request.readOnly = readOnly;
    ctx.state.round = 2;
    ctx.findings.push(f);
    return callTier(ctx, "reviewer", [group], ["a.ts"])?.tier;
  }

  it("moves up for a confirmed finding above nit from an earlier round", async () => {
    expect(await tierWith(finding({}))).toBe("large");
  });

  it.each([
    ["a nit", finding({ severity: "nit" }), false],
    ["a pending finding", finding({ verdict: "pending" }), false],
    ["a read-only run", finding({}), true],
  ])("doesn't move up for %s", async (_name, f, readOnly) => {
    expect(await tierWith(f, readOnly)).toBe("medium");
  });
});
