import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventSchema, type RoundSummary, type RunState } from "@aio/contracts";
import { describe, expect, it } from "vitest";
import { newEngineState } from "../../src/run/engine-state.js";
import { appendJsonLine, readJson, writeJsonAtomic } from "../../src/run/files.js";
import { RunNotFoundError, RunStore, listRunIds } from "../../src/run/store.js";
import { tempDir } from "../tmp.js";

const RUN_ID = "01JB0000000000000000000001";

function tmp(): string {
  return tempDir("aio-store-");
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
  for (const fixture of readdirSync(join(import.meta.dirname, "fixtures"))) {
    it(`loads saved state example ${fixture} without changing the file`, async () => {
      const store = new RunStore(tmp(), RUN_ID);
      const saved = JSON.parse(
        readFileSync(join(import.meta.dirname, "fixtures", fixture), "utf8"),
      );
      await store.writeJson("state.json", saved);
      expect(await store.loadState()).toMatchObject({
        id: RUN_ID,
        status: "paused",
        stage: "preflight",
      });
      expect(JSON.parse(readFileSync(store.path("state.json"), "utf8"))).toEqual(saved);
    });
  }

  it("reopens legacy findings and preserves their verdict history across a state-save interruption", async () => {
    const store = new RunStore(tmp(), RUN_ID);
    const saved = JSON.parse(
      readFileSync(join(import.meta.dirname, "finding-fixtures/v1.json"), "utf8"),
    );
    await store.writeJson("findings.json", saved);
    // The state write can finish before the findings write during a checkpoint.
    await store.saveState(state());
    const findings = await store.loadFindings();
    expect(findings[0]).toMatchObject({ verdict: "confirmed", introduced: false });
    expect(findings[0]?.history.map((h) => h.verdict)).toEqual(["pre-existing", "confirmed"]);
    await store.saveFindings(findings);
    expect(await store.loadFindings()).toEqual(findings);
  });

  it("replays legacy finding events with their historical previous verdict", async () => {
    const store = new RunStore(tmp(), RUN_ID);
    await store.saveState(state());
    const [finding] = JSON.parse(
      readFileSync(join(import.meta.dirname, "finding-fixtures/v1.json"), "utf8"),
    );
    const event = {
      id: "legacy-event",
      time: "2026-10-28T09:00:00.000Z",
      source: "engine:test",
      seq: 1,
      sourceSeq: 1,
      streamId: "legacy",
      type: "finding.changed",
      runId: RUN_ID,
      finding,
      previousVerdict: "pre-existing",
    };
    appendFileSync(store.path("events.jsonl"), JSON.stringify(event) + "\n");
    const [replayed] = await store.loadEvents();
    expect(EventSchema.safeParse(replayed).success).toBe(true);
    expect(replayed).toMatchObject({
      previousVerdict: "pre-existing",
      finding: { verdict: "confirmed", introduced: false },
    });
  });

  it("refuses newer state before parsing it and leaves every saved byte intact", async () => {
    const store = new RunStore(tmp(), RUN_ID);
    await store.writeJson("state.json", { stateVersion: 99, futureState: true });
    const before = readFileSync(store.path("state.json"), "utf8");
    await expect(store.loadState()).rejects.toThrow(/state version 99/);
    expect(readFileSync(store.path("state.json"), "utf8")).toBe(before);
  });

  it("records the current state version when saving a run", async () => {
    const store = new RunStore(tmp(), RUN_ID);
    await store.saveState(state());
    expect(JSON.parse(readFileSync(store.path("state.json"), "utf8")).stateVersion).toBe(2);
  });

  it("keeps the run under .aio/runs/<id>", () => {
    const store = new RunStore("/project", RUN_ID);
    expect(store.dir).toBe(`/project/.aio/runs/${RUN_ID}`);
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
    const file = join(root, ".aio", "runs", RUN_ID, "events.jsonl");
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
