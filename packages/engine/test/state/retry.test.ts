// Retrying a failed run, on a fixture modeled on a real run that failed in its
// verify stage when one vendor's monthly quota ran out and the server kept
// redirecting calls to it: most findings pending, saved disprover calls, and a
// role that moved just as the run failed.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FindingInputSchema, type Finding, type Severity, type Vendor } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import type { EngineDeps, VendorAdapter, VerifyOutput } from "../../src/core.js";
import { RunController } from "../../src/state/controller.js";
import { fixTargets } from "../../src/state/steps.js";
import { contextOf, makeRun } from "./harness.js";
import { buildSampleRepo } from "./scenario.js";

const QUOTA = "You have exceeded your monthly quota (Request ID: EXAMPLE)";
const disproved: VerifyOutput = {
  verdict: "disproved",
  verification: "code-reading",
  evidence: "The code path can't reach this state, so the failure case can't happen.",
  presentAtBase: false,
} as VerifyOutput;

class QuotaError extends Error {}

/** A disprover that records its calls: it answers, or reports a quota with no reset time. */
function disprover(vendor: Vendor, mode: "ok" | "quota", calls: Vendor[]): VendorAdapter {
  const fail = () => Promise.reject(new Error("unused"));
  return {
    vendor,
    review: fail,
    continueReview: fail,
    fix: fail,
    confirm: fail,
    sweep: fail,
    verify: () => {
      calls.push(vendor);
      if (mode === "quota") return Promise.reject(new QuotaError(QUOTA));
      return Promise.resolve({
        output: disproved,
        model: vendor,
        sessionId: null,
        tokens: { in: 1, out: 1 },
        usage: [],
        premiumRequests: 0,
        costEstimate: 0,
      });
    },
    detectLimit: (e: unknown) =>
      e instanceof QuotaError ? { kind: "usage_limit", resetAt: null, message: QUOTA } : null,
  } as unknown as VendorAdapter;
}

function finding(n: number, severity: Severity, runId: string): Finding {
  const id = `F-${String(n).padStart(4, "0")}`;
  return FindingInputSchema.parse({
    id,
    fingerprint: id,
    severity,
    title: `Bug ${id}`,
    file: "shop/cart.py",
    lines: [1, 2],
    failureCase: "It breaks.",
    category: "logic",
    introduced: true,
    reportedBy: "claude-sonnet-5-5",
    verdict: "pending",
    evidence: "",
    runId,
    round: 1,
    groupId: null,
    origin: "reviewer",
  });
}

const FIXTURE_SEVERITIES: Severity[] = ["P1", "P1", "P2", "P3", "nit"];

/**
 * Writes the failed run's files, as an engine from before the retry change
 * left them, and loads the run from them.
 */
async function failedRun(adapters: EngineDeps["adapters"], repo = buildSampleRepo()) {
  const made = await makeRun({
    repo,
    adapters,
    request: {
      roundCap: 1,
      profile: "fast",
      roles: { reviewer: ["claude"], ...(adapters.codex ? { disprover: "codex" } : {}) },
    },
  });
  const { ctx } = made;
  await ctx.setStage("verify");
  ctx.state.round = 1;
  ctx.eng.roundOpen = true;
  ctx.eng.counters.finding = FIXTURE_SEVERITIES.length;
  ctx.eng.appliedMerges = ["rounds/1/merge-commit.json"];
  // The straggler's move: the stored role says what the last call did.
  ctx.state.roles.disprover = "copilot";
  ctx.findings = FIXTURE_SEVERITIES.map((s, i) => finding(i + 1, s, ctx.state.id));
  await ctx.store.saveGroups([], 1);
  await ctx.store.writeJson(ctx.store.roundFile(1, "merge"), { round: 1, created: [] });
  await ctx.store.writeJson("rounds/1/merge-commit.json", { findings: [] });
  // One disprover call finished before the failure, and its finding didn't get its verdict.
  await ctx.store.writeJson(ctx.store.roundFile(1, "calls/verify-F-0001"), {
    vendor: "codex",
    model: "gpt-6-sol",
    sessionId: null,
    output: disproved,
    tokens: { in: 1, out: 1 },
  });
  ctx.state.status = "failed";
  ctx.state.stopReason = "error";
  ctx.state.error = `copilot kept hitting its limit: ${QUOTA}`;
  await ctx.persist();
  // The older engine wrote neither of the fields this change added.
  const file = join(ctx.store.dir, "engine.json");
  const stored = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  delete stored.limitedVendors;
  await writeFile(file, JSON.stringify(stored));
  const run = await RunController.load(ctx.state.id, { projectRoot: repo }, made.deps);
  return { ...made, run, ctx: contextOf(run) };
}

describe("retry of a run that failed on a vendor's limit", () => {
  it("resumes the verify stage and reuses the saved call", async () => {
    const calls: Vendor[] = [];
    const { run } = await failedRun({
      claude: disprover("claude", "ok", []),
      codex: disprover("codex", "ok", calls),
      copilot: disprover("copilot", "ok", calls),
    });
    const started = await run.retry();
    expect(started.status).toBe("running");
    expect(started.error).toBeUndefined();
    expect(started.finishedAt).toBeUndefined();
    expect(started.notices?.[0]).toMatch(/Retried from the verify stage after: copilot kept/);
    // The role goes back to the assignment; the straggler's move doesn't stick.
    expect(started.roles.disprover).toBe("codex");
    const done = await run.settled();
    expect(calls).toEqual(["codex", "codex", "codex", "codex"]);
    expect(run.findings.map((f) => f.verdict)).toEqual(Array(5).fill("disproved"));
    expect(done.status).toBe("finished");
  });

  it("takes a role change that replaces the vendor", async () => {
    const calls: Vendor[] = [];
    const { run } = await failedRun({
      claude: disprover("claude", "ok", []),
      codex: disprover("codex", "ok", calls),
      copilot: disprover("copilot", "ok", calls),
    });
    expect((await run.retry({ roles: { disprover: "copilot" } })).roles.disprover).toBe("copilot");
    await run.settled();
    expect(new Set(calls)).toEqual(new Set(["copilot"]));
  });

  it("takes an assignment made while the run is failed", async () => {
    const calls: Vendor[] = [];
    const { run } = await failedRun({
      claude: disprover("claude", "ok", []),
      codex: disprover("codex", "ok", calls),
      copilot: disprover("copilot", "ok", calls),
    });
    await run.assign("disprover", ["copilot"]);
    expect(run.status).toBe("failed");
    await run.retry();
    await run.settled();
    expect(new Set(calls)).toEqual(new Set(["copilot"]));
  });

  it("waits for a person instead of failing when every disprover reports a quota", async () => {
    const calls: Vendor[] = [];
    const { run, ctx } = await failedRun({
      claude: disprover("claude", "ok", []),
      codex: disprover("codex", "quota", calls),
      copilot: disprover("copilot", "quota", calls),
    });
    await run.retry();
    const state = await run.settled();
    expect(state.status).toBe("waiting_decision");
    expect(state.decision?.kind).toBe("ceiling");
    expect(state.decision?.message).toContain(QUOTA);
    // At most the parallel calls under way when the limit arrived, not one per pending finding.
    expect(calls.length).toBeLessThanOrEqual(4 * 2);
    expect(ctx.eng.limitedVendors.codex?.until).toBeNull();
    expect(ctx.eng.limitedVendors.copilot?.until).toBeNull();
    expect(run.findings.filter((f) => f.verdict === "pending").length).toBeGreaterThan(0);
    // The cross-vendor rule holds: Claude reported these findings.
    expect(calls).not.toContain("claude");
  });

  it("can retry with a floor, and below-floor findings stay pending and labeled", async () => {
    const calls: Vendor[] = [];
    const { run, ctx } = await failedRun({
      claude: disprover("claude", "ok", []),
      codex: disprover("codex", "ok", calls),
    });
    const started = await run.retry({ verifyFloor: "P2" });
    expect(started.request.verifyFloor).toBe("P2");
    const done = await run.settled();
    expect(calls).toHaveLength(2);
    const below = run.findings.filter((f) => f.severity === "P3" || f.severity === "nit");
    expect(below.map((f) => f.verdict)).toEqual(["pending", "pending"]);
    expect(below.every((f) => f.unverifiedReason === "below_verify_floor")).toBe(true);
    expect(fixTargets(ctx)).toEqual([]);
    expect(done.stopReason).toBe("round_cap");
    expect(done.notices?.at(-1)).toMatch(/^2 findings below the P2 verification floor/);
  });

  it("removes a floor with all", async () => {
    const calls: Vendor[] = [];
    const { run, ctx } = await failedRun({
      claude: disprover("claude", "ok", []),
      codex: disprover("codex", "ok", calls),
    });
    ctx.state.request.verifyFloor = "P1";
    const started = await run.retry({ verifyFloor: "all" });
    expect(started.request.verifyFloor).toBeUndefined();
    await run.settled();
    expect(calls).toHaveLength(4);
  });

  it("goes on when the tip moved or the tree is dirty, and says the tip moved", async () => {
    const repo = buildSampleRepo();
    const calls: Vendor[] = [];
    const { run } = await failedRun(
      { claude: disprover("claude", "ok", []), codex: disprover("codex", "ok", calls) },
      repo,
    );
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "x",
    );
    await writeFile(join(repo, "untracked.txt"), "dirty\n");
    const before = run.state.tipSha;
    const started = await run.retry();
    expect(started.notices?.join(" ")).toMatch(/moved from .* since the run saved its tip/);
    expect(started.tipSha).toBe(before);
    expect((await run.settled()).status).toBe("finished");
  });
});

describe("a floor on confirmed findings", () => {
  /** A vendor that records which findings each fixer and sweep prompt names. */
  function recording(vendor: Vendor, seen: { fix: string[]; sweep: string[] }): VendorAdapter {
    const adapter = disprover(vendor, "ok", []);
    const answer = (output: unknown) => ({
      output,
      model: vendor,
      sessionId: null,
      tokens: { in: 1, out: 1 },
      usage: [],
      premiumRequests: 0,
      costEstimate: 0,
    });
    const ids = (prompt: string) => [...new Set(prompt.match(/F-\d{4}/g) ?? [])];
    adapter.fix = ((req: { prompt: string }) => {
      seen.fix.push(...ids(req.prompt));
      return Promise.resolve(
        answer({ fixed: [], notFixed: ids(req.prompt).map((id) => ({ id, reason: "No." })) }),
      );
    }) as never;
    adapter.sweep = ((req: { prompt: string }) => {
      seen.sweep.push(...ids(req.prompt));
      return Promise.resolve(answer({ findings: [] }));
    }) as never;
    return adapter;
  }

  /** The real run's shape: earlier disprovers confirmed findings of mixed severity. */
  async function withConfirmed() {
    const seen = { fix: [] as string[], sweep: [] as string[] };
    const made = await failedRun({
      claude: recording("claude", seen),
      codex: recording("codex", seen),
    });
    const { ctx } = made;
    for (const f of ctx.findings) {
      f.verdict = "confirmed";
      f.history.push({
        time: ctx.nowIso(),
        verdict: "confirmed",
        actor: { kind: "agent", vendor: "codex", role: "disprover" },
        round: 1,
      });
    }
    return { ...made, seen };
  }

  it("keeps a confirmed finding below the floor from the fixer and the sweep", async () => {
    const { run, seen } = await withConfirmed();
    await run.retry({ verifyFloor: "P2" });
    const done = await run.settled();
    expect(new Set(seen.fix)).toEqual(new Set(["F-0001", "F-0002", "F-0003"]));
    expect(new Set(seen.sweep)).toEqual(new Set(["F-0001", "F-0002", "F-0003"]));
    const p3 = run.findings.find((f) => f.id === "F-0004");
    expect(p3?.verdict).toBe("confirmed");
    expect(p3?.fixHeldReason).toBe("below_verify_floor");
    // A nit never goes to the fixer, so the floor isn't what kept it away.
    expect(run.findings.find((f) => f.id === "F-0005")?.fixHeldReason).toBeUndefined();
    expect(done.notices?.at(-1)).toMatch(/^1 confirmed finding below the P2 verification floor/);
  });

  it("drops a held finding from a fix plan saved before the floor rose", async () => {
    const { run, ctx, seen } = await withConfirmed();
    await ctx.setStage("fix");
    await ctx.store.writeJson(ctx.store.roundFile(1, "fix-0-1-plan"), [["F-0002", "F-0004"]]);
    await run.retry({ verifyFloor: "P2" });
    await run.settled();
    expect(seen.fix).toEqual(["F-0002"]);
  });

  it("sends them to the fixer again when the floor is removed", async () => {
    const { run, ctx, seen } = await withConfirmed();
    ctx.state.request.verifyFloor = "P2";
    await run.retry({ verifyFloor: "all" });
    await run.settled();
    expect(seen.fix).toContain("F-0004");
    expect(seen.sweep).toContain("F-0004");
    expect(run.findings.find((f) => f.id === "F-0004")?.fixHeldReason).toBeUndefined();
  });
});

describe("retry refuses", () => {
  const adapters = () => ({
    claude: disprover("claude", "ok", []),
    codex: disprover("codex", "ok", []),
  });

  it("a cancelled run, which stays final", async () => {
    const { run, ctx } = await failedRun(adapters());
    ctx.state.status = "cancelled";
    await expect(run.retry()).rejects.toThrow(/cancelled run is final/);
    await expect(run.assign("disprover", ["codex"])).rejects.toThrow(/cancelled/);
    expect(run.status).toBe("cancelled");
  });

  it.each(["finished", "running", "paused", "waiting_decision"] as const)(
    "a %s run",
    async (status) => {
      const { run, ctx } = await failedRun(adapters());
      ctx.state.status = status;
      await expect(run.retry()).rejects.toThrow(/only a failed run/);
    },
  );

  it("a failed run with no stage to resume", async () => {
    const { run, ctx } = await failedRun(adapters());
    ctx.state.stage = "done";
    await expect(run.retry()).rejects.toThrow(/can't resume from the done stage/);
  });

  it("a stage from the other pipeline", async () => {
    const { run, ctx } = await failedRun(adapters());
    ctx.state.stage = "poll";
    await expect(run.retry()).rejects.toThrow(/pre-push run can't resume from the poll stage/);
  });

  it.each<[string, (c: ReturnType<typeof contextOf>) => void, RegExp]>([
    ["a closed round", (c) => (c.eng.roundOpen = false), /needs an open round/],
    ["a behind counter", (c) => (c.eng.counters.finding = 1), /finding counter 1 is behind/],
    ["a lost tip", (c) => (c.state.tipSha = "0".repeat(40)), /tip commit 0+ isn't in/],
    ["no base", (c) => (c.state.baseSha = undefined), /no base commit/],
    ["a repeated finding", (c) => c.findings.push(c.findings[0] as Finding), /list F-0001 twice/],
    [
      "a lost merge file",
      (c) => c.eng.appliedMerges.push("rounds/1/gone.json"),
      /merge file rounds\/1\/gone.json is missing/,
    ],
  ])("inconsistent state: %s, and changes nothing", async (_name, spoil, message) => {
    const { run, ctx } = await failedRun(adapters());
    spoil(ctx);
    await expect(run.retry({ verifyFloor: "P1" })).rejects.toThrow(message);
    expect(run.status).toBe("failed");
    expect(run.state.error).toContain("kept hitting");
    expect(run.state.request.verifyFloor).toBeUndefined();
  });

  it("findings that no vendor but their reporter could check", async () => {
    const { run } = await failedRun({ claude: disprover("claude", "ok", []) });
    await expect(run.retry()).rejects.toThrow(/No available vendor other than the reporter/);
    // The floor counts only the findings a disprover would have to check.
    await expect(run.retry({ verifyFloor: "P1" })).rejects.toThrow(/2 pending findings/);
  });

  it("a role for a vendor with no adapter", async () => {
    const { run } = await failedRun(adapters());
    await expect(run.retry({ roles: { disprover: "copilot" } })).rejects.toThrow(/No adapter/);
    expect(run.status).toBe("failed");
  });
});

describe("a safety refusal on a disprover call", () => {
  const REFUSED = "This content was flagged for possible cybersecurity risk.";

  /** A disprover that refuses on the listed models and records the model of each call. */
  function refusing(vendor: Vendor, refuse: (model?: string) => boolean, calls: string[]) {
    const base = disprover(vendor, "ok", []);
    return {
      ...base,
      verify: (request: { model?: string }) => {
        calls.push(`${vendor}:${request.model ?? ""}`);
        return refuse(request.model)
          ? Promise.reject(new Error(REFUSED))
          : base.verify(request as never);
      },
    } as unknown as VendorAdapter;
  }

  const tiered = async (run: RunController) => {
    contextOf(run).state.request.modelTier = "auto";
    await contextOf(run).persist();
  };

  it("moves to the small model, without repeating the refused call", async () => {
    const calls: string[] = [];
    const { run } = await failedRun({
      claude: disprover("claude", "ok", []),
      codex: refusing("codex", (m) => m !== "gpt-6-luna", calls),
    });
    await tiered(run);
    await run.retry({ verifyFloor: "P1" });
    await run.settled();
    expect(calls).toContain("codex:gpt-6-luna");
    expect(run.findings[1]?.verdict).toBe("disproved");
    expect(calls.filter((c) => c === "codex:gpt-6.1-terra")).toHaveLength(1);
  });

  it("moves to Claude even when a person assigned the role to Codex", async () => {
    const claude: Vendor[] = [];
    const { run } = await failedRun({
      claude: disprover("claude", "ok", claude),
      codex: refusing("codex", () => true, []),
    });
    await tiered(run);
    const started = await run.retry({ verifyFloor: "P1", roles: { disprover: "codex" } });
    expect(started.status).toBe("running");
    const done = await run.settled();
    expect(claude.length).toBeGreaterThan(0);
    expect(run.findings[1]?.verdict).toBe("disproved");
    expect(done.notices?.join(" ")).toMatch(/Claude answered for finding F-0002/);
  });

  it("flags the finding for follow-up and goes on when Claude fails too", async () => {
    const { run } = await failedRun({
      claude: refusing("claude", () => true, []),
      codex: refusing("codex", () => true, []),
    });
    await tiered(run);
    await run.retry({ verifyFloor: "P1" });
    const done = await run.settled();
    expect(done.status).toBe("finished");
    const flagged = run.findings[1];
    expect(flagged?.verdict).toBe("pending");
    expect(flagged?.followUpReason).toMatch(/flagged/);
    expect(done.notices?.join(" ")).toMatch(/F-0002 needs follow-up/);
  });
});

describe("finish with Claude", () => {
  it("gives Claude the roles and turns off the cross-vendor rule", async () => {
    const claude: Vendor[] = [];
    const codex: Vendor[] = [];
    const { run } = await failedRun({
      claude: disprover("claude", "ok", claude),
      codex: disprover("codex", "quota", codex),
    });
    const started = await run.retry({ finishWithClaude: true });
    expect(started.request.crossVendor).toBe(false);
    expect(started.roles.disprover).toBe("claude");
    expect(started.notices?.join(" ")).toMatch(/checks its own work/);
    await run.settled();
    expect(codex).toEqual([]);
    expect(claude).toHaveLength(4);
  });
});
