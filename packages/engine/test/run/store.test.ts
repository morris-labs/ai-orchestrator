import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RoundSummary, RunState } from "@agentbox/contracts";
import { describe, expect, it } from "vitest";
import { newEngineState } from "../../src/run/engine-state.js";
import { appendJsonLine, readJson, writeJsonAtomic } from "../../src/run/files.js";
import { RunNotFoundError, RunStore, listRunIds } from "../../src/run/store.js";
import { tempDir } from "../tmp.js";

const RUN_ID = "01JB0000000000000000000001";

function tmp(): string {
  return tempDir("agentbox-store-");
}

function state(): RunState {
  return {
    id: RUN_ID,
    projectId: "p",
    container: "c",
    request: {
      projectId: "p",
      repoPath: "/repo",
      base: "origin/main",
      mergeBase: true,
      exactBase: false,
      pipeline: "pre-push",
      profile: "offload",
      readOnly: false,
      includeWorktree: false,
      crossVendor: true,
      roundCap: 25,
      overlapThreshold: 0.5,
      continuationCap: 3,
    },
    status: "pending",
    stage: "preflight",
    round: 0,
    profile: "offload",
    roles: { reviewer: ["codex"], disprover: "codex", confirmer: "codex", fixer: "claude" },
    stopReason: null,
    decision: null,
    createdAt: "2026-10-28T09:00:00.000Z",
    updatedAt: "2026-10-28T09:00:00.000Z",
  };
}

function summary(round: number): RoundSummary {
  return {
    runId: RUN_ID,
    round,
    perVendor: {},
    fixed: round,
    overlapRate: 0,
    costUsd: 0,
    startedAt: "2026-10-28T09:00:00.000Z",
    finishedAt: "2026-10-28T09:01:00.000Z",
  };
}

describe("files", () => {
  it("writes atomically and leaves no temporary files", async () => {
    const dir = tmp();
    await writeJsonAtomic(join(dir, "a/b.json"), { x: 1 });
    await writeJsonAtomic(join(dir, "a/b.json"), { x: 2 });
    expect(JSON.parse(readFileSync(join(dir, "a/b.json"), "utf8"))).toEqual({ x: 2 });
    expect(readdirSync(join(dir, "a"))).toEqual(["b.json"]);
  });

  it("returns undefined for a missing file and validates with a schema", async () => {
    const dir = tmp();
    expect(await readJson(join(dir, "missing.json"))).toBeUndefined();
    await appendJsonLine(join(dir, "e.jsonl"), { a: 1 });
    await appendJsonLine(join(dir, "e.jsonl"), { a: 2 });
    expect(readFileSync(join(dir, "e.jsonl"), "utf8")).toBe('{"a":1}\n{"a":2}\n');
  });
});

describe("RunStore", () => {
  it("keeps the run under .claude-box/runs/<id>", () => {
    const store = new RunStore("/project", RUN_ID);
    expect(store.dir).toBe(`/project/.claude-box/runs/${RUN_ID}`);
    expect(store.roundFile(2, "verify")).toBe("rounds/2/verify.json");
  });

  it("saves and loads state, engine state, findings, and events", async () => {
    const root = tmp();
    const store = new RunStore(root, RUN_ID);
    await expect(store.loadState()).rejects.toBeInstanceOf(RunNotFoundError);
    await store.saveState(state());
    expect((await store.loadState()).id).toBe(RUN_ID);
    expect((await store.loadEngineState()).counters.finding).toBe(0);
    const eng = newEngineState();
    eng.cleanRounds = 1;
    await store.saveEngineState(eng);
    expect((await store.loadEngineState()).cleanRounds).toBe(1);
    expect(await store.loadFindings()).toEqual([]);
    expect(await store.loadEvents()).toEqual([]);
    expect(await listRunIds(root)).toEqual([RUN_ID]);
    expect(await listRunIds(join(root, "nothing"))).toEqual([]);
  });

  it("skips a torn line in events.jsonl instead of losing every event", async () => {
    const root = tmp();
    const store = new RunStore(root, RUN_ID);
    const file = join(root, ".claude-box", "runs", RUN_ID, "events.jsonl");
    await appendJsonLine(file, { type: "usage.sample", seq: 1 });
    await appendJsonLine(file, { type: "usage.sample", seq: 2 });
    appendFileSync(file, '{"type":"usage.sam');
    const skipped: number[] = [];
    const events = await store.loadEvents((n) => skipped.push(n));
    expect(events.map((e) => (e as unknown as { seq: number }).seq)).toEqual([1, 2]);
    expect(skipped).toEqual([1]);
  });

  it("refuses an invalid state", async () => {
    const store = new RunStore(tmp(), RUN_ID);
    await expect(
      store.saveState({ ...state(), status: "bogus" } as unknown as RunState),
    ).rejects.toThrow();
  });

  it("replaces a round summary with the same round and keeps them in order", async () => {
    const store = new RunStore(tmp(), RUN_ID);
    await store.saveRoundSummary(summary(2));
    await store.saveRoundSummary(summary(1));
    await store.saveRoundSummary({ ...summary(2), fixed: 9 });
    const rounds = await store.loadRounds();
    expect(rounds.map((r) => [r.round, r.fixed])).toEqual([
      [1, 1],
      [2, 9],
    ]);
  });
});
