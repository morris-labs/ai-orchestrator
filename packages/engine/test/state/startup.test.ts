// Engine startup: bad run directories, policy typos, usage-limit pauses, and
// base checkouts left by an engine that stopped.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { bridgeAdapters } from "../../src/adapters/bridge.js";
import { GrantingBroker, MemoryEventSink } from "../../src/core.js";
import { EngineLeaseBroker } from "../../src/events/leases.js";
import { createMockAdapters } from "../../src/main/adapters.js";
import { silentLogger } from "../../src/main/logger.js";
import { Git } from "../../src/range/git.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { EngineRunManager, createRunManager } from "../../src/state/manager.js";
import { BaseWorktree, baseWorktreePath } from "../../src/verify/verify.js";
import { buildSampleRepo } from "./scenario.js";
import { uniqueRunId } from "./run-ids.js";

const SCRIPT = join(import.meta.dirname, "../smoke/mock-script.json");
const runId = uniqueRunId;

function deps(repo: string) {
  return {
    projectRoot: repo,
    container: "c",
    events: new MemoryEventSink("engine:test", "s"),
    leases: new GrantingBroker(),
    adapters: bridgeAdapters(createMockAdapters(SCRIPT)),
    log: silentLogger,
  };
}

async function settle(runs: EngineRunManager, id: string): Promise<RunState> {
  for (let i = 0; i < 600; i++) {
    const s = await runs.get(id);
    if (s && !["pending", "running", "paused"].includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`run ${id} didn't settle`);
}

/** A finished read-only run, rewritten on disk to look as `patch` says. */
async function leftRun(repo: string, patch: Partial<RunState>): Promise<string> {
  const id = runId();
  const runs = new EngineRunManager(deps(repo));
  await runs.start({
    runId: id,
    projectId: "sample",
    depth: "thorough",
    repoPath: repo,
    base: "origin/main",
    readOnly: true,
  } as never);
  await settle(runs, id);
  // Wait for the driver's last write before rewriting the file under it.
  const controllers = (
    runs as unknown as { controllers: Map<string, { settled(): Promise<unknown> }> }
  ).controllers;
  await controllers.get(id)?.settled();
  const file = join(repo, ".aio/runs", id, "state.json");
  const state = JSON.parse(readFileSync(file, "utf8")) as RunState;
  writeFileSync(
    file,
    JSON.stringify({ ...state, finishedAt: undefined, stopReason: null, ...patch }),
  );
  return id;
}

describe("engine startup", () => {
  it("survives a policy typo and fails only the run that goes on", async () => {
    const repo = buildSampleRepo();
    const id = await leftRun(repo, { status: "pending", stage: "preflight", round: 0 });
    const policy = join(repo, ".aio/policy.yaml");
    const good = readFileSync(policy, "utf8");
    writeFileSync(policy, `${good}\ntsets: []\n`);
    const runs = await createRunManager(deps(repo));
    const state = await settle(runs, id);
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/policy file .* is invalid/);
    await runs.close();
  });

  it("marks a run with a corrupt engine.json failed and starts anyway", async () => {
    const repo = buildSampleRepo();
    const broken = await leftRun(repo, { status: "running" });
    writeFileSync(join(repo, ".aio/runs", broken, "engine.json"), "{ not json");
    const runs = await createRunManager(deps(repo));
    const state = JSON.parse(
      readFileSync(join(repo, ".aio/runs", broken, "state.json"), "utf8"),
    ) as RunState;
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/couldn't load the run/);
    expect(runs.activeRunCount()).toBe(0);
    expect((await runs.list({})).length).toBeGreaterThan(0);
    await runs.close();
  });

  it("resumes a run paused for a usage limit when the limit resets, without counting it active", async () => {
    const repo = buildSampleRepo();
    const until = new Date(Date.now() + 300).toISOString();
    const id = await leftRun(repo, {
      status: "paused",
      pausedUntil: until,
      stage: "preflight",
      round: 0,
    });
    const runs = await createRunManager(deps(repo));
    expect(runs.activeRunCount()).toBe(0);
    expect((await runs.get(id))?.status).toBe("paused");
    const state = await settle(runs, id);
    expect(state.status).toBe("finished");
    expect(state.pausedUntil).toBeUndefined();
    await runs.close();
  });

  it("removes a base checkout that a stopped engine left behind", async () => {
    const repo = buildSampleRepo();
    const id = await leftRun(repo, { status: "failed", stopReason: "error" });
    const path = baseWorktreePath(id);
    execFileSync("git", ["worktree", "add", "--detach", "--force", path, "HEAD"], { cwd: repo });
    const runs = await createRunManager(deps(repo));
    // Loading the run, as any API call about it does, clears the leftover.
    expect((await runs.get(id))?.status).toBe("failed");
    expect(existsSync(path)).toBe(false);
    expect(
      execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }),
    ).not.toContain(path);
    await runs.close();
  });

  it("excludes its run directory from git when the project root is the repository", async () => {
    const repo = buildSampleRepo();
    const exclude = join(repo, ".git", "info", "exclude");
    const without = readFileSync(exclude, "utf8").replace(".aio/\n", "");
    writeFileSync(exclude, without);
    await leftRun(repo, {});
    expect(readFileSync(exclude, "utf8")).toBe(`${without}.aio/\n`);
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(status).toBe("");
  });

  it("removes the directory of a base checkout that git couldn't create", async () => {
    const repo = buildSampleRepo();
    const path = baseWorktreePath(runId());
    const wt = new BaseWorktree(new Git(new ExecaRunner(), repo), "no-such-commit", path);
    await expect(wt.ensure()).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
  });
});

describe("base checkouts", () => {
  it("are removed when a run is cancelled in the middle of verify", async () => {
    const { Scenario } = await import("./scenario.js");
    const { makeRun } = await import("./harness.js");
    const scenario = new Scenario({ hang: { method: "verify", nth: 1 } });
    const { run, ctx } = await makeRun({ adapters: scenario.adapters() });
    await run.start();
    const path = baseWorktreePath(ctx.state.id);
    for (let i = 0; i < 400 && scenario.count("verify") < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(scenario.count("verify"), "the run never reached verify").toBeGreaterThanOrEqual(1);
    expect(existsSync(path)).toBe(true);
    await run.cancel();
    expect(existsSync(path)).toBe(false);
  });
});

describe("engine shutdown", () => {
  it("leaves a run that waits for a lease running, and the next engine finishes it", async () => {
    const repo = buildSampleRepo();
    const broker = new EngineLeaseBroker({ log: silentLogger });
    const id = runId();
    const runs = await createRunManager({ ...deps(repo), leases: broker });
    await runs.start({
      runId: id,
      projectId: "sample",
      depth: "thorough",
      repoPath: repo,
      base: "origin/main",
      readOnly: true,
    } as never);
    for (let i = 0; i < 400 && broker.pendingIds().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(broker.pendingIds().length, "the run never asked for a lease").toBeGreaterThan(0);

    // The order that `startEngine`'s close uses.
    const closed = runs.close();
    broker.close();
    await closed;
    // Let the old driver finish whatever it does with the closed broker.
    const controllers = (
      runs as unknown as { controllers: Map<string, { settled(): Promise<unknown> }> }
    ).controllers;
    await controllers.get(id)?.settled();
    const file = join(repo, ".aio/runs", id, "state.json");
    const left = JSON.parse(readFileSync(file, "utf8")) as RunState;
    expect(left.status).toBe("running");
    expect(left.error).toBeUndefined();

    const next = await createRunManager(deps(repo));
    const state = await settle(next, id);
    expect(state.status).toBe("finished");
    await next.close();
  });
});

describe("BaseWorktree after dispose", () => {
  it("refuses to create the checkout again", async () => {
    const repo = buildSampleRepo();
    const path = baseWorktreePath(runId());
    const wt = new BaseWorktree(new Git(new ExecaRunner(), repo), "HEAD", path);
    await wt.ensure();
    await wt.dispose();
    await expect(wt.ensure()).rejects.toThrow(/already removed/);
    expect(existsSync(path)).toBe(false);
  });
});
