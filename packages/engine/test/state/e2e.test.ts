// End-to-end runs of the pre-push pipeline on tools/sample-repo with fake
// vendors scripted from its planted bugs.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventSchema, FindingSchema, RunStateSchema, type Finding } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { FakeClock, GrantingBroker, MemoryEventSink, type EngineDeps } from "../../src/core.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { RunController } from "../../src/state/controller.js";
import { Scenario, bugPresent, buildSampleRepo } from "./scenario.js";

let seq = 0;
function runId(): string {
  seq += 1;
  return `01JB${String(seq).padStart(22, "0")}`;
}

function deps(
  scenario: Scenario,
  extra: Partial<EngineDeps> = {},
): EngineDeps & { events: MemoryEventSink } {
  const clock = new FakeClock();
  const events = new MemoryEventSink("engine:test", "stream-test", clock);
  return {
    adapters: scenario.adapters(),
    broker: new GrantingBroker(clock),
    runner: new ExecaRunner(),
    clock,
    container: "aio-agent-proj-sample",
    ...extra,
    events: (extra.events as MemoryEventSink | undefined) ?? events,
  };
}

async function start(repo: string, d: EngineDeps, overrides: Record<string, unknown> = {}) {
  const run = await RunController.create(
    { runId: runId(), projectId: "sample", repoPath: repo, base: "origin/main", ...overrides },
    { projectRoot: repo },
    d,
  );
  await run.start();
  return run;
}

function byTitle(findings: Finding[], title: string): Finding {
  const f = findings.find((x) => x.title === title);
  if (!f) throw new Error(`no finding titled ${title}`);
  return f;
}

describe("pre-push end to end", () => {
  it("finds, verifies, fixes, gates, confirms, and converges", async () => {
    const repo = buildSampleRepo();
    const scenario = new Scenario({ badFixes: true });
    const d = deps(scenario);
    const run = await start(repo, d);
    const state = await run.settled();

    expect(state.error).toBeUndefined();
    expect(state.status).toBe("finished");
    expect(state.stopReason).toBe("clean");
    expect(state.round).toBe(4);

    const findings = run.findings;
    for (const f of findings) FindingSchema.parse(f);
    const bugs = scenario.bugs;
    const verdict = (id: string) => byTitle(findings, bugs.find((b) => b.id === id)!.title);
    for (const id of ["B1", "B2", "B3", "B4", "B5", "B6"]) {
      expect(verdict(id).verdict, id).toBe("fixed");
      expect(verdict(id).fixCommit, id).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(verdict("B7").verdict).toBe("pre-existing");
    expect(verdict("B7").introduced).toBe(false);
    expect(verdict("FP1").verdict).toBe("disproved");
    expect(verdict("B2").origin).toBe("sweep");
    expect(verdict("B1").alsoReportedBy.length).toBe(1);
    expect(verdict("B1").verification).toBe("script");
    expect(verdict("B5").verification).toBe("code-reading");
    expect(findings).toHaveLength(8);

    // The code is fixed for real, and the pre-existing bug is left alone.
    for (const bug of bugs.filter((b) => !b.falsePositive)) {
      expect(bugPresent(bug, repo), bug.id).toBe(bug.id === "B7");
    }

    // The ledger follow-up and the continuation ran.
    expect(scenario.calls.some((c) => c.prompt.startsWith("Your ledger has no verdict"))).toBe(
      true,
    );
    expect(scenario.count("continueReview", "codex")).toBeGreaterThan(1);
    // The gate caught the bad fix and the second attempt passed.
    const gate1 = JSON.parse(readFileSync(join(run.runDir, "rounds/1/gate-0-1.json"), "utf8"));
    const gate2 = JSON.parse(readFileSync(join(run.runDir, "rounds/1/gate-0-2.json"), "utf8"));
    expect(gate1.regressed).toBe(true);
    expect(gate2.regressed).toBe(false);
    expect(
      scenario.calls.filter((c) => c.method === "fix" && c.prompt.includes("## Gate failure")),
    ).toHaveLength(1);
    // Cross-vendor: no finding was verified by the vendor that reported it.
    for (const f of findings.filter((x) => x.origin !== "sweep")) {
      const disprover = f.history.find((h) => h.actor.role === "disprover");
      if (disprover)
        expect(f.reportedBy.startsWith(disprover.actor.vendor ?? "?"), f.id).toBe(false);
    }
    // Offload: Claude only fixes.
    expect(
      scenario.calls.filter((c) => c.vendor === "claude").every((c) => c.method === "fix"),
    ).toBe(true);

    // Run files.
    for (const file of [
      "state.json",
      "engine.json",
      "findings.json",
      "events.jsonl",
      "preflight.json",
      "groups.json",
      "rounds.json",
    ]) {
      expect(existsSync(join(run.runDir, file)), file).toBe(true);
    }
    for (const stage of [
      "groups",
      "find",
      "ledger",
      "merge",
      "verify",
      "sweep",
      "fix-0-1",
      "fix-0-1-plan",
      "confirm",
      "summary",
    ]) {
      expect(existsSync(join(run.runDir, `rounds/1/${stage}.json`)), stage).toBe(true);
    }
    RunStateSchema.parse(JSON.parse(readFileSync(join(run.runDir, "state.json"), "utf8")));
    const rounds = await run.rounds();
    expect(rounds.map((r) => r.round)).toEqual([1, 2, 3, 4]);
    expect(rounds[0]?.perVendor.copilot?.raised).toBe(3);
    expect(rounds[0]?.perVendor.codex?.raised).toBe(5);
    expect(rounds[0]?.fixed).toBe(5);
    expect(rounds[1]?.fixed).toBe(1);
    expect(rounds[0]?.overlapRate).toBeCloseTo(1 / 6);
    expect(rounds[0]?.costUsd).toBeGreaterThan(0);

    // Events: valid, mirrored to events.jsonl, every agent paired with a settlement.
    const events = d.events.events;
    for (const e of events) EventSchema.parse(e);
    const lines = readFileSync(join(run.runDir, "events.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(events.length);
    const started = d.events.ofType("agent.started").length;
    expect(d.events.ofType("agent.finished")).toHaveLength(started);
    expect(d.events.ofType("lease.settled")).toHaveLength(started);
    expect((d.broker as GrantingBroker).requests).toHaveLength(started);
    expect(d.events.ofType("handoff").some((h) => h.artifact === "findings" && h.count > 0)).toBe(
      true,
    );
    expect(d.events.ofType("stage.changed").map((s) => s.stage)).toContain("confirm");
    expect(d.events.ofType("usage.sample").length).toBeGreaterThan(0);
    expect(d.events.ofType("run.changed").filter((e) => e.roundSummary !== null)).toHaveLength(4);
    expect(events.at(-1)?.type).toBe("run.changed");

    // The temporary base checkout is gone.
    const worktrees = execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" })
      .trim()
      .split("\n");
    expect(worktrees).toHaveLength(1);
  });

  it("resumes from the stage where the engine stopped", async () => {
    const repo = buildSampleRepo();
    const first = new Scenario({ hang: { method: "fix", nth: 1 } });
    const d1 = deps(first);
    const run1 = await start(repo, d1);
    // Wait until the fixer hangs.
    for (let i = 0; i < 400 && first.count("fix") === 0; i++)
      await new Promise((r) => setTimeout(r, 25));
    expect(first.count("fix")).toBe(1);
    expect(run1.state.stage).toBe("fix");
    const reviewsBefore = first.count("review");
    const verifiesBefore = first.count("verify");

    // A new engine loads the run from disk and continues at the fix stage.
    const second = new Scenario();
    const d2 = deps(second);
    const run2 = await RunController.load(run1.id, { projectRoot: repo }, d2);
    expect(run2.state.stage).toBe("fix");
    expect(run2.state.status).toBe("running");
    await run2.start();
    const state = await run2.settled();
    expect(state.status).toBe("finished");
    expect(state.stopReason).toBe("clean");
    // Round 1's reviewers and disprovers did not run again.
    expect(second.calls.filter((c) => c.method === "review" && c.round === 1)).toHaveLength(0);
    expect(second.count("verify")).toBeLessThan(verifiesBefore);
    expect(reviewsBefore).toBeGreaterThan(0);
    expect(run2.findings.filter((f) => f.verdict === "fixed")).toHaveLength(6);
  });

  it("stops for a decision when a fixed finding comes back, then converges after a waive", async () => {
    const repo = buildSampleRepo();
    const scenario = new Scenario({ forceReports: [{ vendor: "copilot", round: 2, bugId: "B3" }] });
    const d = deps(scenario);
    const run = await start(repo, d);
    let state = await run.settled();
    expect(state.status).toBe("waiting_decision");
    expect(state.decision?.kind).toBe("oscillation");
    expect(state.decision?.options).toEqual(["resume", "resume_waive", "cancel"]);
    const [fixedId, returnedId] = state.decision?.findingIds ?? [];
    expect(run.findings.find((f) => f.id === fixedId)?.verdict).toBe("fixed");
    expect(run.findings.find((f) => f.id === returnedId)?.verdict).toBe("pending");
    expect(state.stage).toBe("verify");

    await run.decide({
      option: "resume_waive",
      waiveFindingIds: [],
      reason: "Already fixed; the reviewer read a stale line.",
    });
    state = await run.settled();
    expect(state.status).toBe("finished");
    expect(state.stopReason).toBe("clean");
    const returned = run.findings.find((f) => f.id === returnedId);
    expect(returned?.verdict).toBe("waived");
    expect(returned?.history.at(-1)?.actor.kind).toBe("human");
  });

  it("pauses at a ceiling until the reset time, and waits for a decision on a denied lease", async () => {
    const repo = buildSampleRepo();
    const scenario = new Scenario();
    const clock = new FakeClock();
    const resumeAt = new Date(clock.now() + 3 * 3600_000).toISOString();
    let fixerAsks = 0;
    let denied = false;
    const granting = new GrantingBroker(clock);
    const broker = {
      requests: granting.requests,
      settle: granting.settle.bind(granting),
      acquire: async (req: Parameters<GrantingBroker["acquire"]>[0]) => {
        if (req.role === "fixer" && (++fixerAsks, clock.now() < Date.parse(resumeAt))) {
          return {
            decision: "pause" as const,
            leaseId: req.leaseId,
            resumeAt,
            reason: "Claude is above 60% of its 5-hour window.",
          };
        }
        // The first Copilot review after the fixer's pause: round 2.
        if (req.role === "reviewer" && req.vendor === "copilot" && fixerAsks > 0 && !denied) {
          denied = true;
          return {
            decision: "deny" as const,
            leaseId: req.leaseId,
            reason: "Copilot reached its monthly ceiling.",
            action: "pause" as const,
          };
        }
        return granting.acquire(req);
      },
    };
    const d = deps(scenario, {
      broker,
      clock,
      events: new MemoryEventSink("engine:test", "s", clock),
    });
    const run = await start(repo, d);
    let state = await run.settled();
    expect(state.status).toBe("waiting_decision");
    expect(state.decision?.kind).toBe("ceiling");
    expect(state.decision?.options).toEqual(["resume", "cancel"]);

    const paused = d.events.ofType("run.changed").find((e) => e.run.status === "paused");
    expect(paused?.run.pausedUntil).toBe(resumeAt);
    expect(clock.now()).toBeGreaterThanOrEqual(Date.parse(resumeAt));

    await run.decide({ option: "resume", waiveFindingIds: [] });
    state = await run.settled();
    expect(state.status).toBe("finished");
    expect(state.stopReason).toBe("clean");
  });
});
