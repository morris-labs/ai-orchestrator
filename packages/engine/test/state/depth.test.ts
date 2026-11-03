// The `standard` depth: batched verification, its fallbacks and resume, one
// reviewer pass, and round 2 on the fixer's diff alone.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FindingInputSchema,
  RunStateSchema,
  type Finding,
  type Severity,
  type Vendor,
} from "@aio/contracts";
import { describe, expect, it } from "vitest";
import type { EngineDeps, VendorAdapter } from "../../src/core.js";
import { parsePolicyExtras } from "../../src/policy/load.js";
import { planVerifyBatches, rootCauseDuplicates } from "../../src/verify/batch.js";
import { planReviews } from "../../src/state/profiles.js";
import { verifyPending } from "../../src/state/steps.js";
import { RunStore } from "../../src/run/store.js";
import { makeRun, nextRunId } from "./harness.js";

const REFUSED = "This content was flagged for possible cybersecurity risk.";
type Handler = (request: { prompt: string; model?: string; repoPath: string }) => unknown;

function adapter(vendor: Vendor, handlers: Record<string, Handler>): VendorAdapter {
  const call = (method: string) => async (request: never) => {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unexpected ${method} call on ${vendor}.`);
    return {
      output: await handler(request),
      model: (request as { model?: string }).model ?? vendor,
      sessionId: "session",
      tokens: { in: 1, out: 1 },
      usage: [],
      premiumRequests: 0,
      costEstimate: 0,
    };
  };
  return {
    vendor,
    review: call("review"),
    continueReview: call("continueReview"),
    verify: call("verify"),
    verifyBatch: call("verifyBatch"),
    fix: call("fix"),
    confirm: call("confirm"),
    sweep: call("sweep"),
    detectLimit: () => null,
  } as unknown as VendorAdapter;
}

const verdict = (id: string, v: "confirmed" | "disproved" = "disproved") => ({
  id,
  verdict: v,
  verification: "code-reading",
  evidence: "The code path shows what happens with this input.",
  presentAtBase: false,
  script: null,
});

const idsIn = (prompt: string) => [...prompt.matchAll(/^### (F-\d+)$/gm)].map((m) => m[1]);

function finding(
  n: number,
  runId: string,
  patch: Partial<{ severity: Severity; reportedBy: string; groupId: string; title: string }> = {},
): Finding {
  const id = `F-${String(n).padStart(4, "0")}`;
  return FindingInputSchema.parse({
    id,
    fingerprint: id,
    severity: patch.severity ?? "P2",
    title: patch.title ?? `Unrelated problem number ${n} with word${n}`,
    file: `shop/file${n}.py`,
    lines: [1, 2],
    failureCase: `Input ${n} gives wrong output ${n * 7}.`,
    category: "correctness",
    introduced: true,
    reportedBy: patch.reportedBy ?? "codex-gpt-6-luna",
    verdict: "pending",
    evidence: "",
    runId,
    round: 1,
    groupId: patch.groupId ?? "G01",
    origin: "reviewer",
  });
}

async function verifyRun(adapters: EngineDeps["adapters"], findings: (id: string) => Finding[]) {
  const made = await makeRun({ adapters, request: { depth: "standard" } });
  const { ctx } = made;
  ctx.state.round = 1;
  ctx.findings = findings(ctx.state.id);
  await ctx.store.saveGroups([], 1);
  return made;
}

describe("batched verification", () => {
  it("checks a group's findings in one call and leaves a missing verdict pending", async () => {
    const prompts: string[] = [];
    const { ctx } = await verifyRun(
      {
        copilot: adapter("copilot", {
          verifyBatch: ({ prompt }) => {
            prompts.push(prompt);
            return { verdicts: [verdict("F-0001"), verdict("F-0002", "confirmed")] };
          },
        }),
        codex: adapter("codex", {}),
      },
      (id) => [finding(1, id), finding(2, id), finding(3, id)],
    );
    await verifyPending(ctx, ctx.store.roundFile(1, "verify"));
    expect(prompts).toHaveLength(1);
    expect(idsIn(prompts[0] as string)).toEqual(["F-0001", "F-0002", "F-0003"]);
    expect(ctx.findings.map((f) => f.verdict)).toEqual(["disproved", "confirmed", "pending"]);
    expect(ctx.findings[2]?.followUpReason).toBeUndefined();
  });

  it("checks a finding with no verdict again in the next round", async () => {
    let calls = 0;
    const { ctx } = await verifyRun(
      {
        copilot: adapter("copilot", {
          verifyBatch: ({ prompt }) => {
            calls += 1;
            return {
              verdicts: idsIn(prompt)
                .slice(1)
                .map((id) => verdict(id as string)),
            };
          },
        }),
        codex: adapter("codex", {}),
      },
      (id) => [finding(1, id), finding(2, id)],
    );
    await verifyPending(ctx, ctx.store.roundFile(1, "verify"));
    expect(ctx.findings[0]?.verdict).toBe("pending");
    ctx.state.round = 2;
    await ctx.store.saveGroups([], 2);
    let second: string[] = [];
    ctx.deps.adapters.copilot = adapter("copilot", {
      verifyBatch: ({ prompt }) => {
        second = idsIn(prompt) as string[];
        return { verdicts: second.map((id) => verdict(id)) };
      },
    });
    await verifyPending(ctx, ctx.store.roundFile(2, "verify"));
    expect(calls).toBe(1);
    expect(second).toEqual(["F-0001"]);
    expect(ctx.findings[0]?.verdict).toBe("disproved");
  });

  it("partitions by reporter, so no vendor checks its own findings", async () => {
    const seen: Record<string, unknown[]> = { codex: [], copilot: [], claude: [] };
    const record = (v: Vendor) =>
      adapter(v, {
        verifyBatch: ({ prompt }) => {
          const ids = idsIn(prompt);
          (seen[v] as unknown[]).push(...ids);
          return { verdicts: ids.map((id) => verdict(id as string)) };
        },
      });
    const { ctx } = await verifyRun(
      { codex: record("codex"), copilot: record("copilot"), claude: record("claude") },
      (id) => [
        finding(1, id, { reportedBy: "codex-x" }),
        finding(2, id, { reportedBy: "copilot-x" }),
        finding(3, id, { reportedBy: "codex-x" }),
      ],
    );
    await verifyPending(ctx, ctx.store.roundFile(1, "verify"));
    expect(seen.codex).toEqual(["F-0002"]);
    expect(seen.copilot).toEqual(["F-0001", "F-0003"]);
    expect(seen.claude).toEqual([]);
  });

  it("retries a refused batch through the fallback before it splits", async () => {
    const calls: string[] = [];
    const { ctx } = await verifyRun(
      {
        copilot: adapter("copilot", {}),
        codex: adapter("codex", {
          verifyBatch: ({ prompt, model }) => {
            calls.push(`codex:${model}`);
            if (model !== "gpt-6-luna") throw new Error(REFUSED);
            return { verdicts: idsIn(prompt).map((id) => verdict(id as string)) };
          },
        }),
      },
      (id) => [
        finding(1, id, { reportedBy: "copilot-x" }),
        finding(2, id, { reportedBy: "copilot-x" }),
      ],
    );
    await verifyPending(ctx, ctx.store.roundFile(1, "verify"));
    expect(calls.at(-1)).toBe("codex:gpt-6-luna");
    expect(ctx.findings.map((f) => f.verdict)).toEqual(["disproved", "disproved"]);
  });

  it("splits a batch every model refused, so one finding can't flag the group", async () => {
    const single: string[] = [];
    const refuseAll = () => {
      throw new Error(REFUSED);
    };
    const { ctx } = await verifyRun(
      {
        copilot: adapter("copilot", {}),
        claude: adapter("claude", {
          verifyBatch: refuseAll,
          verify: ({ prompt }) => {
            if (prompt.includes("file1.py")) throw new Error(REFUSED);
            return verdict("x");
          },
        }),
        codex: adapter("codex", {
          verifyBatch: refuseAll,
          verify: ({ prompt }) => {
            single.push(prompt);
            if (prompt.includes("file1.py")) throw new Error(REFUSED);
            return verdict("x");
          },
        }),
      },
      (id) => [
        finding(1, id, { reportedBy: "copilot-x" }),
        finding(2, id, { reportedBy: "copilot-x" }),
      ],
    );
    await verifyPending(ctx, ctx.store.roundFile(1, "verify"));
    expect(single.length).toBeGreaterThanOrEqual(2);
    expect(ctx.findings[0]?.verdict).toBe("pending");
    expect(ctx.findings[0]?.followUpReason).toMatch(/cybersecurity/);
    expect(ctx.findings[1]?.verdict).toBe("disproved");
    expect(ctx.findings[1]?.followUpReason).toBeUndefined();
  });

  it("flags a lone refused finding without a second round of calls", async () => {
    let batchCalls = 0;
    const { ctx } = await verifyRun(
      {
        copilot: adapter("copilot", {}),
        codex: adapter("codex", {
          verifyBatch: () => {
            batchCalls += 1;
            throw new Error(REFUSED);
          },
        }),
      },
      (id) => [finding(1, id, { reportedBy: "copilot-x" })],
    );
    await verifyPending(ctx, ctx.store.roundFile(1, "verify"));
    expect(batchCalls).toBe(2); // The call, and the small model.
    expect(ctx.findings[0]?.followUpReason).toBeTruthy();
  });

  it("answers from a saved call when verdicts were part applied before a restart", async () => {
    let calls = 0;
    const answer = {
      verifyBatch: ({ prompt }: { prompt: string }) => {
        calls += 1;
        return { verdicts: idsIn(prompt).map((id) => verdict(id as string)) };
      },
    };
    const { ctx } = await verifyRun(
      { copilot: adapter("copilot", answer), codex: adapter("codex", {}) },
      (id) => [finding(1, id), finding(2, id)],
    );
    const file = ctx.store.roundFile(1, "verify");
    await verifyPending(ctx, file);
    expect(calls).toBe(1);
    const second = ctx.findings[1] as Finding;
    second.verdict = "pending";
    second.history = second.history.filter((h) => h.verdict !== "disproved");
    await verifyPending(ctx, file);
    expect(calls).toBe(1);
    expect(second.verdict).toBe("disproved");
  });

  it("reruns a reproduction script that a batch verdict supplies", async () => {
    const script = "#!/bin/sh\nexit 1\n";
    const { ctx } = await verifyRun(
      {
        copilot: adapter("copilot", {
          verifyBatch: () => ({
            verdicts: [
              {
                ...verdict("F-0001", "confirmed"),
                script: { path: "repro.sh", interpreter: "sh", content: script },
              },
            ],
          }),
        }),
        codex: adapter("codex", {}),
      },
      (id) => [finding(1, id)],
    );
    await verifyPending(ctx, ctx.store.roundFile(1, "verify"));
    const f = ctx.findings[0] as Finding;
    // The script exits 1 at the tip and at the base, so the flaw predates the change.
    expect(f.verdict).toBe("pre-existing");
    expect(f.verification).toBe("script");
    expect(f.evidence).toMatch(/Engine rerun at tip: exit 1/);
  });

  it("drops a same-root-cause duplicate from the prompt, then gives it the verdict", async () => {
    let ids: unknown[] = [];
    const { ctx } = await verifyRun(
      {
        copilot: adapter("copilot", {
          verifyBatch: ({ prompt }) => {
            ids = idsIn(prompt);
            return { verdicts: ids.map((id) => verdict(id as string, "confirmed")) };
          },
        }),
        codex: adapter("codex", {}),
      },
      (id) => {
        const a = finding(1, id, { title: "Parser drops the last record of the file" });
        const b = finding(2, id, {
          title: "Parser drops the last record of the file",
          severity: "P1",
        });
        return [a, { ...b, file: a.file }];
      },
    );
    await verifyPending(ctx, ctx.store.roundFile(1, "verify"));
    expect(ids).toEqual(["F-0002"]);
    expect(ctx.findings.map((f) => f.verdict)).toEqual(["confirmed", "confirmed"]);
    expect(ctx.findings[0]?.evidence).toMatch(/same root cause as F-0002/);
  });

  it("splits only on tokens, never on the number of findings", async () => {
    const many = Array.from({ length: 90 }, (_, i) => finding(i + 1, nextRunId()));
    const options = {
      vendorFor: () => "codex" as const,
      reporterFor: () => "copilot" as const,
      tokensFor: () => 10,
    };
    expect(planVerifyBatches(many, options)).toHaveLength(1);
    const big = planVerifyBatches(many, { ...options, tokensFor: () => 20_000 });
    expect(big.length).toBeGreaterThan(1);
    expect(big.flatMap((b) => b.ids)).toHaveLength(90);
  });

  it("finds no duplicate among unrelated findings", () => {
    expect(rootCauseDuplicates([finding(1, nextRunId()), finding(2, nextRunId())]).size).toBe(0);
  });

  it("keeps a thorough run on per-finding calls", async () => {
    const prompts: string[] = [];
    const made = await makeRun({
      adapters: {
        copilot: adapter("copilot", {
          verify: ({ prompt }) => {
            prompts.push(prompt);
            return verdict("x");
          },
        }),
        codex: adapter("codex", {}),
      },
      request: { depth: "thorough" },
    });
    const { ctx } = made;
    ctx.state.round = 1;
    ctx.findings = [finding(1, ctx.state.id), finding(2, ctx.state.id)];
    await ctx.store.saveGroups([], 1);
    await verifyPending(ctx, ctx.store.roundFile(1, "verify"));
    expect(prompts).toHaveLength(2);
  });
});

describe("reviewer plan at the standard depth", () => {
  const groups = [
    { id: "G01", files: ["a"], kind: "major", changedLines: 90, riskPath: false, hunks: [] },
    { id: "G02", files: ["b"], kind: "major", changedLines: 90, riskPath: false, hunks: [] },
  ] as const;

  it("gives each group one reviewer and leaves Copilot out unless named", () => {
    const tasks = planReviews(["claude", "codex", "copilot"], groups as never, "balanced", {
      depth: "standard",
    });
    expect(tasks.map((t) => t.key)).toEqual(["G01-claude", "G02-codex"]);
    expect(
      planReviews(["codex", "copilot"], groups as never, "offload", {
        depth: "standard",
        named: ["codex", "copilot"],
      }).map((t) => t.vendor),
    ).toEqual(["copilot", "codex", "codex"]);
    expect(
      planReviews(["copilot"], groups as never, "offload", { depth: "standard" }).map((t) => t.key),
    ).toEqual(["all-copilot"]);
  });

  it("keeps the thorough plan", () => {
    expect(planReviews(["codex", "claude"], groups as never, "balanced")).toHaveLength(4);
  });
});

describe("rounds at the standard depth", () => {
  const raw = (file: string, line: number) => ({
    severity: "P1",
    title: `Bug in ${file}`,
    file,
    lines: [line, line],
    failure_case: "Input breaks it.",
    category: "correctness",
    introduced: true,
  });

  it("reviews the fixer's diff alone in round 2, and stops clean after it", async () => {
    const reviews: string[] = [];
    const continued: string[] = [];
    let repo = "";
    const review: Handler = ({ prompt }) => {
      reviews.push(prompt);
      return { findings: reviews.length === 1 ? [raw("shop/cart.py", 1)] : [], ledger: [] };
    };
    const made = await makeRun({
      adapters: {
        codex: adapter("codex", {
          review,
          continueReview: ({ prompt }) => {
            continued.push(prompt);
            return { findings: [], ledger: [] };
          },
          confirm: () => ({ incomplete: [], findings: [] }),
          sweep: () => ({ findings: [] }),
        }),
        copilot: adapter("copilot", {
          verifyBatch: ({ prompt }) => ({
            verdicts: idsIn(prompt).map((id) => verdict(id as string, "confirmed")),
          }),
        }),
        claude: adapter("claude", {
          fix: () => {
            writeFileSync(join(repo, "fix_marker.py"), "FIXED_BY_THE_FIXER = 1\n");
            execFileSync("git", ["add", "fix_marker.py"], { cwd: repo });
            execFileSync("git", ["commit", "-qm", "Fix F-0001"], { cwd: repo });
            return { fixed: ["F-0001"], notFixed: [], summary: "" };
          },
        }),
      },
      request: { depth: "standard" },
    });
    repo = made.repo;
    const { run, ctx } = made;
    await run.start();
    const state = await run.settled();
    expect(state.error).toBeUndefined();
    expect(state.stopReason).toBe("clean");
    expect(ctx.round).toBe(2);
    expect(continued).toEqual([]);
    // Every reviewer call of round 2 reads only the fix, and one has it.
    const second = reviews.filter((p) => p.includes("in round 2"));
    expect(second.length).toBeGreaterThan(0);
    expect(second.join("\n")).toContain("FIXED_BY_THE_FIXER");
    expect(second.join("\n")).toContain("only what the fixer changed");
    expect(second.join("\n")).not.toContain("diff --git a/shop/cart.py");
    expect(reviews[0]).toContain("Report only P1 and P2");
    expect(reviews[0]).toContain("no cap on the number of findings");
  });

  it("stops after one round when round 1 confirms nothing", async () => {
    const made = await makeRun({
      adapters: {
        codex: adapter("codex", { review: () => ({ findings: [], ledger: [] }) }),
        copilot: adapter("copilot", {}),
        claude: adapter("claude", {}),
      },
      request: { depth: "standard" },
    });
    await made.run.start();
    const state = await made.run.settled();
    expect(state.stopReason).toBe("clean");
    expect(made.ctx.round).toBe(1);
  });

  it("spends no reviewer call in round 2 when no fix changed anything", async () => {
    const reviews: string[] = [];
    const made = await makeRun({
      adapters: {
        codex: adapter("codex", {
          review: ({ prompt }) => {
            reviews.push(prompt);
            return { findings: [raw("shop/cart.py", 1)], ledger: [] };
          },
          sweep: () => ({ findings: [] }),
        }),
        copilot: adapter("copilot", {
          verifyBatch: ({ prompt }) => ({
            verdicts: idsIn(prompt).map((id) => verdict(id as string, "confirmed")),
          }),
        }),
        claude: adapter("claude", {}),
      },
      request: { depth: "standard", readOnly: true },
    });
    await made.run.start();
    const state = await made.run.settled();
    expect(state.error).toBeUndefined();
    expect(made.ctx.round).toBe(2);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.filter((p) => p.includes("in round 2"))).toEqual([]);
  });

  it("uses the small Codex model for a disprover on a docs-only group", async () => {
    const models: unknown[] = [];
    const { ctx } = await verifyRun(
      {
        copilot: adapter("copilot", {}),
        codex: adapter("codex", {
          verifyBatch: ({ prompt, model }) => {
            models.push(model);
            return { verdicts: idsIn(prompt).map((id) => verdict(id as string)) };
          },
        }),
      },
      (id) => [{ ...finding(1, id, { reportedBy: "copilot-x" }), file: "docs/a.md" }],
    );
    await ctx.store.saveGroups(
      [
        {
          id: "G01",
          files: ["docs/a.md"],
          kind: "minor",
          changedLines: 2,
          riskPath: false,
          hunks: [],
          tier: "small",
          tierReason: "docs",
        },
      ],
      1,
    );
    await verifyPending(ctx, ctx.store.roundFile(1, "verify"));
    expect(models).toEqual(["gpt-6-luna"]);
  });

  it("lets an explicit round cap and continuation cap override the depth", async () => {
    const { ctx } = await makeRun({
      adapters: { codex: adapter("codex", {}) },
      request: { depth: "standard", roundCap: 5, continuationCap: 2, verifyFloor: "P3" },
    });
    expect(ctx.state.request).toMatchObject({ roundCap: 5, continuationCap: 2, verifyFloor: "P3" });
  });
});

describe("runs that predate depths", () => {
  it("loads a stored run with no depth, which keeps the thorough behavior", async () => {
    const { ctx } = await makeRun({ adapters: { codex: adapter("codex", {}) } });
    const { depth: _depth, ...request } = ctx.state.request;
    const stored = RunStateSchema.parse({ ...ctx.state, request });
    expect(stored.request.depth).toBeUndefined();
    const store = new RunStore(ctx.store.projectRoot, ctx.state.id);
    await store.saveState(stored);
    expect((await store.loadState())?.request.depth).toBeUndefined();
  });
});

describe("the policy's group size limit", () => {
  it("counts as named only when the file names it", () => {
    expect(parsePolicyExtras("version: 1\n").groupSizeLimit).toBeNull();
    expect(parsePolicyExtras("version: 1\ngroupSizeLimit: 77\n").groupSizeLimit).toBe(77);
  });
});
