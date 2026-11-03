// The fix and gate stages across a resume and a gate decision.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { FindingInputSchema, type Finding, type LeaseRequest } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import {
  GrantingBroker,
  FakeClock,
  type AdapterRequest,
  type AdapterResult,
  type FixOutput,
  type VendorAdapter,
} from "../../src/core.js";
import { DecisionNeeded } from "../../src/state/context.js";
import { chooseConfirmer, fixTargets, runConfirm, runFix } from "../../src/state/steps.js";
import { makeRun } from "./harness.js";
import { Scenario, buildSampleRepo } from "./scenario.js";
import { tempDir } from "../tmp.js";

function confirmed(id: string, groupId: string, runId: string): Finding {
  const f = FindingInputSchema.parse({
    id,
    fingerprint: id,
    severity: "P1",
    title: `Bug ${id}`,
    file: "shop/cart.py",
    lines: [1, 2],
    failureCase: "It breaks.",
    category: "logic",
    introduced: true,
    reportedBy: "codex-x",
    verdict: "confirmed",
    evidence: "",
    runId,
    round: 1,
    groupId,
    origin: "reviewer",
  });
  return f;
}

type FixPlan = (ids: string[], call: number) => FixOutput | "crash";

/** A fixer that commits one file per call and answers from `plan`. */
function fixer(plan: FixPlan): { adapter: VendorAdapter; calls: string[][] } {
  const calls: string[][] = [];
  const fail = () => Promise.reject(new Error("unused"));
  const adapter = {
    vendor: "claude",
    review: fail,
    continueReview: fail,
    verify: fail,
    confirm: fail,
    sweep: fail,
    detectLimit: () => null,
    fix(request: AdapterRequest): Promise<AdapterResult<FixOutput>> {
      const ids = [...request.prompt.matchAll(/^- (F-\d+) \[/gm)].map((m) => m[1] as string);
      calls.push(ids);
      const output = plan(ids, calls.length);
      if (output === "crash") return Promise.reject(new Error("engine stopped"));
      const repo = request.repoPath;
      appendFileSync(join(repo, "fixes.txt"), `${ids.join(",")}\n`);
      execFileSync("git", ["add", "fixes.txt"], { cwd: repo });
      execFileSync("git", ["commit", "-qm", `fix ${ids.join(",")}`], { cwd: repo });
      return Promise.resolve({
        output,
        model: "claude",
        sessionId: null,
        tokens: { in: 1, out: 1 },
        usage: [],
        premiumRequests: 0,
        costEstimate: 0,
      });
    },
  } as unknown as VendorAdapter;
  return { adapter, calls };
}

async function fixRun(plan: FixPlan) {
  const f = fixer(plan);
  const h = await makeRun({ adapters: { claude: f.adapter } });
  h.ctx.state.round = 1;
  h.ctx.state.roles.fixer = "claude";
  h.ctx.findings.push(
    confirmed("F-0001", "G1", h.ctx.state.id),
    confirmed("F-0002", "G2", h.ctx.state.id),
    confirmed("F-0003", "G3", h.ctx.state.id),
  );
  return { ...h, fixer: f };
}

describe("the confirmer after a mid-round fixer assignment", () => {
  /** An adapter that fixes like `fixer` and records its confirm calls. */
  function vendorWith(plan: FixPlan): { adapter: VendorAdapter; confirms: number[] } {
    const confirms: number[] = [];
    const adapter = {
      ...fixer(plan).adapter,
      confirm: () => {
        confirms.push(1);
        return Promise.resolve({
          output: { incomplete: [], findings: [] },
          model: "m",
          sessionId: null,
          tokens: { in: 1, out: 1 },
          usage: [],
          premiumRequests: 0,
          costEstimate: 0,
        });
      },
    } as unknown as VendorAdapter;
    return { adapter, confirms };
  }

  const fixAll: FixPlan = (ids) => ({ fixed: ids, notFixed: [], summary: "" });

  async function fixedRun(extra: Parameters<typeof makeRun>[0] = {}) {
    const claude = vendorWith(fixAll);
    const codex = vendorWith(fixAll);
    const h = await makeRun({
      request: { profile: "offload" },
      ...extra,
      adapters: { claude: claude.adapter, codex: codex.adapter, ...extra.adapters },
    });
    h.ctx.state.round = 1;
    h.ctx.state.roles = { ...h.ctx.state.roles, fixer: "claude", confirmer: "codex" };
    return { ...h, claude, codex };
  }

  it("keeps the vendor that wrote the fixes away from its own fixes", async () => {
    const { ctx, claude, codex } = await fixedRun();
    ctx.findings.push(confirmed("F-0001", "G1", ctx.state.id));
    await runFix(ctx, ctx.findings);
    await ctx.assignNow("fixer", ["codex"]);
    // The assignment leaves claude as the only vendor other than the new fixer.
    expect(ctx.state.roles).toMatchObject({ fixer: "codex", confirmer: "claude" });
    const record = await runConfirm(ctx, []);
    expect(record.confirmer).toBe("codex");
    expect(claude.confirms).toHaveLength(0);
    expect(codex.confirms).toHaveLength(1);
  });

  it("stops for a person when every vendor wrote some of the fixes", async () => {
    const ref: { assign?: () => void } = {};
    const claude = vendorWith((ids) => {
      ref.assign?.();
      return fixAll(ids, 0);
    });
    const { ctx, codex } = await fixedRun({ adapters: { claude: claude.adapter } });
    ref.assign = () => void ctx.assignNow("fixer", ["codex"]);
    ctx.findings.push(
      confirmed("F-0001", "G1", ctx.state.id),
      confirmed("F-0002", "G2", ctx.state.id),
    );
    await runFix(ctx, ctx.findings);
    expect(ctx.eng.roundFixers).toEqual(["claude", "codex"]);
    await expect(runConfirm(ctx, [])).rejects.toBeInstanceOf(DecisionNeeded);
    expect(claude.confirms).toHaveLength(0);
    expect(codex.confirms).toHaveLength(0);
  });

  it("moves to a vendor that wrote nothing when one is available", () => {
    expect(chooseConfirmer("codex", ["claude"], ["claude", "codex"])).toBe("codex");
    expect(chooseConfirmer("claude", ["claude"], ["claude", "codex", "copilot"])).toBe("codex");
    expect(chooseConfirmer("codex", ["claude", "codex"], ["claude", "codex", "copilot"])).toBe(
      "copilot",
    );
    expect(chooseConfirmer("codex", ["claude", "codex"], ["claude", "codex"])).toBeNull();
  });

  it("avoids the fixer role for a run saved before the engine recorded fixers", async () => {
    const { ctx, codex } = await fixedRun();
    const head = await ctx.git.head();
    ctx.findings.push({ ...confirmed("F-0001", "G1", ctx.state.id), fixCommit: head });
    ctx.eng.preFixSha = head;
    // A run saved before the engine recorded fixers falls back to the role.
    expect(ctx.eng.roundFixers).toEqual([]);
    await runConfirm(ctx, []);
    expect(codex.confirms).toHaveLength(1);
  });
});

describe("runFix", () => {
  it("stops before the gate when the fixer leaves edits it didn't commit", async () => {
    const { ctx, repo } = await fixRun((ids, call) => {
      if (call === 1) writeFileSync(join(repo, "SYNTHETIC_uncommitted.py"), "x = 1\n");
      return { fixed: ids, notFixed: [], summary: "" };
    });
    await expect(runFix(ctx, fixTargets(ctx))).rejects.toThrow(
      /The fixer left changes it didn't commit .*SYNTHETIC_uncommitted\.py/,
    );
    // Once a person cleans up, the stage goes on without calling the fixer again.
    rmSync(join(repo, "SYNTHETIC_uncommitted.py"));
    const record = await runFix(ctx, fixTargets(ctx));
    expect(record.batches).toHaveLength(3);
  });

  it("keeps each batch's commits and the batch plan across a restart", async () => {
    // Batch 1 declines F-0001; batch 2 fails twice, which stops the stage.
    let crashes = 0;
    const { ctx, fixer: f } = await fixRun((ids) => {
      if (ids.includes("F-0001"))
        return { fixed: [], notFixed: [{ id: "F-0001", reason: "Not a defect." }], summary: "" };
      if (ids.includes("F-0002") && crashes < 2) {
        crashes += 1;
        return "crash";
      }
      return { fixed: ids, notFixed: [], summary: "" };
    });
    await expect(runFix(ctx, fixTargets(ctx))).rejects.toThrow();
    // The resumed stage recomputes its targets, which no longer hold F-0001.
    const record = await runFix(ctx, fixTargets(ctx));
    expect(f.calls).toEqual([["F-0001"], ["F-0002"], ["F-0002"], ["F-0002"], ["F-0003"]]);
    expect(record.batches.map((b) => b.findingIds)).toEqual([["F-0001"], ["F-0002"], ["F-0003"]]);
    expect(ctx.findingById("F-0002")?.fixCommit).toBe(record.batches[1]?.after);
    expect(ctx.findingById("F-0003")?.fixCommit).toBe(record.batches[2]?.after);
    expect(ctx.findingById("F-0001")?.fixCommit).toBeUndefined();
  });

  // Finding 47: the resumed batch took HEAD after the fixer's commits as its
  // start, found no commits, and never recorded the fix.
  it("keeps a batch's commits when the engine stopped before the batch file was saved", async () => {
    const { ctx, fixer: f } = await fixRun((ids) => ({ fixed: ids, notFixed: [], summary: "" }));
    const writeJson = ctx.store.writeJson.bind(ctx.store);
    let stopped = false;
    ctx.store.writeJson = (file, value) => {
      if (!stopped && /^rounds\/1\/fix-0-1-[0-9a-f]{12}\.json$/.test(file)) {
        stopped = true;
        return Promise.reject(new Error("engine stopped"));
      }
      return writeJson(file, value);
    };
    await expect(runFix(ctx, fixTargets(ctx))).rejects.toThrow(/engine stopped/);
    ctx.store.writeJson = writeJson;
    const record = await runFix(ctx, fixTargets(ctx));
    // The fixer's answer for the first batch came from the saved call.
    expect(f.calls).toEqual([["F-0001"], ["F-0002"], ["F-0003"]]);
    expect(record.batches[0]?.commits).toHaveLength(1);
    expect(ctx.findingById("F-0001")?.fixCommit).toBe(record.batches[0]?.after);
  });

  it("accepts a decline only for the batch's own findings", async () => {
    const { ctx } = await fixRun((ids) => ({
      fixed: [],
      notFixed: [
        { id: "F-0003", reason: "Injected." },
        ...(ids.includes("F-0002") ? [{ id: "F-0002", reason: "Already handled upstream." }] : []),
      ],
      summary: "",
    }));
    await runFix(
      ctx,
      fixTargets(ctx).filter((f) => f.id !== "F-0003"),
    );
    expect(ctx.eng.declined).toEqual(["F-0002"]);
    expect(fixTargets(ctx).map((f) => f.id)).toEqual(["F-0001", "F-0003"]);
    const history = ctx.findingById("F-0002")?.history.at(-1);
    expect(history).toMatchObject({ verdict: "confirmed", actor: { role: "fixer" } });
    expect(history?.evidence).toContain("Already handled upstream.");
  });

  // Finding 51: a decline with an empty reason was ignored, so the finding
  // stayed a fix target and went to the fixer again in every round.
  it("stops sending a finding the fixer declined without a reason", async () => {
    const { ctx } = await fixRun((ids) => ({
      fixed: [],
      notFixed: ids.includes("F-0001") ? [{ id: "F-0001", reason: " " }] : [],
      summary: "",
    }));
    await runFix(ctx, fixTargets(ctx));
    expect(ctx.eng.declined).toEqual(["F-0001"]);
    expect(fixTargets(ctx).map((f) => f.id)).toEqual(["F-0002", "F-0003"]);
    const finding = ctx.findingById("F-0001");
    expect(finding?.verdict).toBe("confirmed");
    expect(finding?.history.at(-1)?.evidence).toContain("gave no reason");
  });
});

describe("a gate_failed decision", () => {
  it("runs the fix and the gate again on resume instead of replaying them", async () => {
    const repo = buildSampleRepo();
    const markerDir = tempDir("aio-marker-");
    const marker = join(markerDir, "broken");
    writeFileSync(
      join(repo, ".aio/policy.yaml"),
      `version: 1\ntests:\n  - command: test ! -f ${marker}\n`,
    );
    const clock = new FakeClock();
    const granting = new GrantingBroker(clock);
    const broker = {
      settle: granting.settle.bind(granting),
      acquire: (req: LeaseRequest) => {
        // The first fix breaks the gate until a person repairs it.
        if (req.role === "fixer" && !existsSync(join(markerDir, "seen"))) {
          writeFileSync(join(markerDir, "seen"), "");
          writeFileSync(marker, "");
        }
        return granting.acquire(req);
      },
    };
    const scenario = new Scenario();
    const { run } = await makeRun({ repo, broker, adapters: scenario.adapters() });
    await run.start();
    let state = await run.settled();
    expect(state.status).toBe("waiting_decision");
    expect(state.decision?.kind).toBe("gate_failed");
    const fixesBefore = scenario.count("fix");
    rmSync(marker);
    await run.decide({ option: "resume", waiveFindingIds: [] });
    state = await run.settled();
    expect(state.status).toBe("finished");
    expect(scenario.count("fix")).toBeGreaterThan(fixesBefore);
    expect(existsSync(join(run.runDir, "rounds/1/gate-1-1.json"))).toBe(true);
  });
});
