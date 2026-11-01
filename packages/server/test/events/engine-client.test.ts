import { openDatabase } from "../../src/db/index.js";
import { FindingSchema, type AioEvent, type Finding, type LeaseRequest } from "@aio/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineClient, type StreamCursor } from "../../src/events/engine-client.js";
import { EngineSupervisor, engineEventRefusal, sqliteCursor } from "../../src/events/engines.js";
import { RunMirror } from "../../src/events/run-mirror.js";
import { CONTAINER, PROJECT_ID, RUN, runState } from "../api/fixtures.js";
import { ENGINE_TOKEN, FakeEngineServer, waitFor } from "./fake-engine.js";

let engine: FakeEngineServer;
let client: EngineClient | null;
let received: AioEvent[];
let resyncs: number;
let cursor: StreamCursor;

const runEvent = { type: "run.changed", run: runState, roundSummary: null } as const;

function build(overrides: Partial<ConstructorParameters<typeof EngineClient>[0]> = {}) {
  client = new EngineClient({
    endpoint: {
      container: CONTAINER,
      projectId: PROJECT_ID,
      hostPort: engine.port,
      token: ENGINE_TOKEN,
    },
    expectedVersion: "1.0.0-dev",
    cursor,
    onEvent: (e) => received.push(e),
    onLease: async (req) => ({
      decision: "granted",
      leaseId: req.leaseId,
      vendor: req.vendor,
      redirectedFrom: null,
      expiresAt: "2026-10-28T10:00:00.000Z",
    }),
    onResync: () => (resyncs += 1),
    backoffMs: [20],
    ...overrides,
  });
  return client;
}

beforeEach(async () => {
  engine = await new FakeEngineServer().start();
  received = [];
  resyncs = 0;
  const db = openDatabase(":memory:");
  cursor = sqliteCursor(db, CONTAINER);
});

afterEach(async () => {
  await client?.stop();
  client = null;
  await engine.stop();
});

describe("EngineClient", () => {
  it("checks health and the version", async () => {
    const c = build();
    await c.health();
    expect(c.info).toEqual({
      hostPort: engine.port,
      version: "1.0.0-dev",
      healthy: true,
      versionMatches: true,
    });
    expect(() => c.assertVersion()).not.toThrow();
  });

  it("raises engine_mismatch for another version and does not subscribe", async () => {
    engine.version = "3.9.0";
    const c = build();
    c.start();
    await waitFor(() => c.info.versionMatches === false);
    expect(() => c.assertVersion()).toThrow(expect.objectContaining({ code: "engine_mismatch" }));
    expect(engine.hellos).toHaveLength(0);
  });

  it("raises engine_mismatch when the engine reports its own mismatch", async () => {
    engine.versionMatches = false;
    const c = build();
    await c.health();
    expect(c.info.versionMatches).toBe(false);
    expect(() => c.assertVersion()).toThrow(expect.objectContaining({ code: "engine_mismatch" }));
  });

  it("calls engine routes with the token and validates responses", async () => {
    const c = build();
    expect(await c.call("engine.runs.get", { params: { runId: RUN } })).toEqual(runState);
    await expect(
      c.call("engine.runs.get", { params: { runId: "01JB8Z5K3W6Q2V9X4T7R0M1N2Q" } }),
    ).rejects.toMatchObject({
      code: "run_not_found",
      status: 404,
    });
  });

  it("turns a body that isn't JSON into an ApiError", async () => {
    const c = build({
      fetch: async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    });
    await expect(c.call("engine.runs.list")).rejects.toMatchObject({
      code: "internal",
      message: "The engine answered 502 with a body that isn't JSON.",
    });
  });

  it("reports an unreachable engine", async () => {
    const c = build();
    await engine.stop();
    await expect(c.call("engine.runs.list")).rejects.toMatchObject({ code: "conflict" });
    engine = await new FakeEngineServer().start();
  });

  it("subscribes, relays events, and keeps the cursor", async () => {
    const c = build();
    c.start();
    await waitFor(() => engine.sockets.length === 1 && engine.hellos.length === 1);
    expect(engine.hellos[0]).toEqual({ type: "hello", streamId: null, lastSeq: null });
    await waitFor(() => resyncs === 1);
    engine.emit(runEvent);
    await waitFor(() => received.length === 1);
    expect(received[0]).toMatchObject({ type: "run.changed", seq: 1 });
    expect(cursor.get()).toEqual({ streamId: "engine-stream-1", lastSeq: 1 });
  });

  it("reconnects and replays from its cursor", async () => {
    const c = build();
    c.start();
    await waitFor(() => engine.sockets.length === 1);
    engine.emit(runEvent);
    await waitFor(() => received.length === 1);
    engine.dropSockets();
    engine.events.push({ ...engine.events[0]!, id: "e2", seq: 2, sourceSeq: 2 });
    await waitFor(() => engine.hellos.length === 2 && received.length === 2);
    expect(engine.hellos[1]).toEqual({ type: "hello", streamId: "engine-stream-1", lastSeq: 1 });
    expect(received[1]?.seq).toBe(2);
    expect(resyncs).toBe(1);
  });

  it("asks for a resync when the engine's stream id changed", async () => {
    cursor.set("old-stream", 7);
    const c = build();
    c.start();
    await waitFor(() => resyncs === 1);
    expect(cursor.get()).toEqual({ streamId: "engine-stream-1", lastSeq: 0 });
  });

  it("answers lease requests on the same socket", async () => {
    const requests: LeaseRequest[] = [];
    const c = build({
      onLease: async (req) => {
        requests.push(req);
        return {
          decision: "pause",
          leaseId: req.leaseId,
          resumeAt: "2026-10-28T10:00:00.000Z",
          reason: "ceiling",
        };
      },
    });
    c.start();
    await waitFor(() => engine.sockets.length === 1);
    engine.sendRaw({
      type: "lease.request",
      leaseId: "L-1",
      runId: RUN,
      vendor: "claude",
      role: "fixer",
      estimate: { tokens: 10 },
    });
    await waitFor(() => engine.leaseResponses.length === 1);
    expect(requests[0]).toEqual({
      leaseId: "L-1",
      runId: RUN,
      vendor: "claude",
      role: "fixer",
      estimate: { tokens: 10 },
    });
    expect(engine.leaseResponses[0]).toMatchObject({ decision: "pause", leaseId: "L-1" });
  });

  it("logs an event that fails to relay and leaves the cursor before it", async () => {
    const logs: string[] = [];
    const c = build({
      onEvent: () => {
        throw new Error("SQLITE_BUSY");
      },
      log: (m) => logs.push(m),
    });
    c.start();
    await waitFor(() => engine.sockets.length === 1 && cursor.get() !== null);
    engine.emit(runEvent);
    await waitFor(() => logs.some((l) => l.includes("failed to relay")));
    expect(cursor.get()?.lastSeq).toBe(0);
  });

  it("replays an event whose relay failed even when a later one relays", async () => {
    let failures = 1;
    const c = build({
      onEvent: (e) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("SQLITE_BUSY");
        }
        received.push(e);
      },
    });
    c.start();
    await waitFor(() => engine.sockets.length === 1 && cursor.get() !== null);
    engine.emit(runEvent);
    engine.emit(runEvent);
    await waitFor(() => received.length === 2);
    expect(received.map((e) => e.seq)).toEqual([1, 2]);
    expect(cursor.get()?.lastSeq).toBe(2);
  });

  it("pauses the run when deciding a lease fails", async () => {
    const c = build({
      onLease: async () => {
        throw new Error("no ceilings");
      },
    });
    c.start();
    await waitFor(() => engine.sockets.length === 1);
    engine.sendRaw({
      type: "lease.request",
      leaseId: "L-1",
      runId: RUN,
      vendor: "claude",
      role: "fixer",
      estimate: { tokens: 10 },
    });
    await waitFor(() => engine.leaseResponses.length === 1);
    expect(engine.leaseResponses[0]).toEqual({
      decision: "deny",
      leaseId: "L-1",
      reason: "The server could not decide the lease: no ceilings",
      action: "pause",
    });
  });

  it("ignores an invalid frame", async () => {
    const logs: string[] = [];
    const c = build({ log: (m) => logs.push(m) });
    c.start();
    await waitFor(() => engine.sockets.length === 1);
    engine.sendRaw({ type: "nonsense" });
    await waitFor(() => logs.some((l) => l.includes("invalid frame")));
    expect(received).toHaveLength(0);
  });
});

describe("EngineSupervisor", () => {
  it("starts a client per endpoint, relays, decides leases, and drops removed containers", async () => {
    const db = openDatabase(":memory:");
    const relayed: AioEvent[] = [];
    const runs: unknown[] = [];
    let endpoints = [
      { container: CONTAINER, projectId: PROJECT_ID, hostPort: engine.port, token: ENGINE_TOKEN },
    ];
    const sup = new EngineSupervisor({
      engines: { list: async () => endpoints },
      db,
      expectedVersion: "1.0.0-dev",
      relay: (e) => relayed.push(e),
      decideLease: async (engineKey, projectId, req) => ({
        decision: "deny",
        leaseId: req.leaseId,
        reason: `${engineKey}/${projectId}`,
        action: "fail_role",
      }),
      onRuns: (list) => runs.push(...list),
      intervalMs: 50,
    });
    sup.start();
    await waitFor(() => sup.get(CONTAINER)?.connected === true);
    await waitFor(() => runs.length === 1);
    expect(sup.forProject(PROJECT_ID)).toBe(sup.get(CONTAINER));
    expect(sup.requireProject(PROJECT_ID)).toBe(sup.get(CONTAINER));
    engine.emit(runEvent);
    await waitFor(() => relayed.length === 1);
    engine.sendRaw({
      type: "lease.request",
      leaseId: "L-2",
      runId: RUN,
      vendor: "codex",
      role: "reviewer",
      estimate: { tokens: 1 },
    });
    await waitFor(() => engine.leaseResponses.length === 1);
    expect(engine.leaseResponses[0]).toMatchObject({
      decision: "deny",
      reason: `${CONTAINER}/${PROJECT_ID}`,
    });
    endpoints = [];
    await sup.refresh();
    expect(sup.get(CONTAINER)).toBeUndefined();
    expect(() => sup.requireProject(PROJECT_ID)).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    await sup.stop();
  });

  it("reloads runs and their findings and drops cached leases when the stream starts over", async () => {
    const db = openDatabase(":memory:");
    const mirror = new RunMirror(db);
    const finding = (id: string, verdict: Finding["verdict"]) =>
      FindingSchema.parse({
        id,
        fingerprint: "3f786850e387550fdab836ed7e6dc881de23001b",
        severity: "P1",
        title: "Retry loop never gives up",
        file: "src/mailer.ts",
        lines: [1, 2],
        failureCase: "A closed socket retries forever.",
        category: "correctness",
        introduced: true,
        reportedBy: "codex-gpt-5",
        alsoReportedBy: [],
        verdict,
        verification: "code-reading",
        evidence: "",
        runId: RUN,
        round: 1,
        groupId: "G-01",
        hunkIds: ["H-0001"],
        origin: "reviewer",
        history: [],
      });
    // The mirror holds a stale state from before the engine restarted.
    mirror.upsertFinding(finding("F-0001", "pending"));
    mirror.upsertFinding(finding("F-0009", "pending"));
    engine.findings = [finding("F-0001", "confirmed")];
    const resets: string[] = [];
    const sup = new EngineSupervisor({
      engines: {
        list: async () => [
          {
            container: CONTAINER,
            projectId: PROJECT_ID,
            hostPort: engine.port,
            token: ENGINE_TOKEN,
          },
        ],
      },
      db,
      expectedVersion: "1.0.0-dev",
      relay: () => undefined,
      decideLease: async () => {
        throw new Error("unused");
      },
      onRuns: (list) => list.forEach((r) => mirror.upsert(r)),
      onFindings: (runId, list) => mirror.replaceFindings(runId, list),
      onStreamReset: (key) => resets.push(key),
      intervalMs: 50,
    });
    sup.start();
    await waitFor(() => mirror.findings(RUN).length === 1);
    expect(resets).toEqual([CONTAINER]);
    expect(mirror.get(RUN)?.id).toBe(RUN);
    expect(mirror.findings(RUN).map((f) => [f.id, f.verdict])).toEqual([["F-0001", "confirmed"]]);
    await sup.stop();
  });
});

describe("engine event admission", () => {
  const endpoint = { container: CONTAINER, projectId: PROJECT_ID };
  const OTHER_PROJECT = "other-app-9f8e7d6c";
  const OTHER_RUN = "01JB8Z5K3W6Q2V9X4T7R0M1N2Q";
  const base = {
    id: "e1",
    time: "2026-10-28T09:00:00.000Z",
    source: `engine:${CONTAINER}`,
    streamId: "S",
    seq: 1,
    sourceSeq: 1,
  };
  const ev = (event: Record<string, unknown>) => ({ ...base, ...event }) as AioEvent;
  const stage = (runId: string) =>
    ev({ type: "stage.changed", runId, round: 1, stage: "find", previousStage: null });

  function seededDb() {
    const db = openDatabase(":memory:");
    const mirror = new RunMirror(db);
    mirror.upsert(runState);
    mirror.upsert({
      ...runState,
      id: OTHER_RUN,
      projectId: OTHER_PROJECT,
      container: `aio-agent-proj-${OTHER_PROJECT}`,
      boxId: undefined,
    });
    db.prepare(
      "INSERT INTO projects (id, root, data, created_at, updated_at) VALUES (?, ?, '{}', ?, ?)",
    ).run(OTHER_PROJECT, "/work/other-app", "2026-10-28T09:00:00.000Z", "2026-10-28T09:00:00.000Z");
    db.prepare(
      `INSERT INTO boxes (id, project_id, host_key, target_dir, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, '{}', ?, ?)`,
    ).run(
      "SYNTHETIC_OTHER_BOX",
      OTHER_PROJECT,
      "other",
      "/work/other-app",
      "2026-10-28T09:00:00.000Z",
      "2026-10-28T09:00:00.000Z",
    );
    return db;
  }

  it("accepts the engine's own events", () => {
    const db = seededDb();
    expect(engineEventRefusal(db, endpoint, runEvent as unknown as AioEvent)).toBeNull();
    expect(engineEventRefusal(db, endpoint, stage(RUN))).toBeNull();
    expect(
      engineEventRefusal(
        db,
        endpoint,
        ev({ type: "ports.changed", container: CONTAINER, listeners: [] }),
      ),
    ).toBeNull();
  });

  it("refuses event types only the server emits", () => {
    const db = seededDb();
    for (const event of [
      ev({ type: "box.changed", boxId: "B", status: "stopped", box: null }),
      ev({ type: "settings.changed", settings: {}, changedKeys: [] }),
      ev({
        type: "terminal.ended",
        terminalId: "T",
        boxId: null,
        kind: "job",
        exitCode: 0,
        unexpected: false,
      }),
    ]) {
      expect(engineEventRefusal(db, endpoint, event)).toMatch(/don't emit/);
    }
  });

  it("refuses events for another container, project, run, or box", () => {
    const db = seededDb();
    const other = `aio-agent-proj-${OTHER_PROJECT}`;
    expect(
      engineEventRefusal(
        db,
        endpoint,
        ev({ type: "ports.changed", container: other, listeners: [] }),
      ),
    ).not.toBeNull();
    // A run of another project, and a run the server never saw.
    expect(engineEventRefusal(db, endpoint, stage(OTHER_RUN))).toMatch(OTHER_PROJECT);
    expect(engineEventRefusal(db, endpoint, stage("01JB8Z5K3W6Q2V9X4T7R0M1N2R"))).toMatch(
      /unknown/,
    );
    const hijack = (run: Record<string, unknown>) =>
      ev({ type: "run.changed", run: { ...runState, ...run }, roundSummary: null });
    // Taking over another project's run, claiming another project, or holding its box.
    expect(engineEventRefusal(db, endpoint, hijack({ id: OTHER_RUN }))).not.toBeNull();
    expect(
      engineEventRefusal(db, endpoint, hijack({ projectId: OTHER_PROJECT, container: other })),
    ).not.toBeNull();
    expect(engineEventRefusal(db, endpoint, hijack({ boxId: "SYNTHETIC_OTHER_BOX" }))).toMatch(
      OTHER_PROJECT,
    );
    expect(engineEventRefusal(db, endpoint, hijack({ container: other }))).not.toBeNull();
  });

  it("drops a refused event, logs it, and relays the rest", async () => {
    const db = seededDb();
    const relayed: AioEvent[] = [];
    const logs: string[] = [];
    const sup = new EngineSupervisor({
      engines: {
        list: async () => [
          {
            container: CONTAINER,
            projectId: PROJECT_ID,
            hostPort: engine.port,
            token: ENGINE_TOKEN,
          },
        ],
      },
      db,
      expectedVersion: "1.0.0-dev",
      relay: (e) => relayed.push(e),
      decideLease: async () => {
        throw new Error("unused");
      },
      log: (m) => logs.push(m),
      intervalMs: 50,
    });
    sup.start();
    await waitFor(() => sup.get(CONTAINER)?.connected === true);
    engine.emit({
      type: "box.changed",
      boxId: "SYNTHETIC_OTHER_BOX",
      status: "stopped",
      box: null,
    });
    engine.emit({
      type: "stage.changed",
      runId: OTHER_RUN,
      round: 1,
      stage: "find",
      previousStage: null,
    });
    engine.emit(runEvent);
    await waitFor(() => relayed.length === 1);
    expect(relayed[0]?.type).toBe("run.changed");
    expect(logs.filter((l) => l.startsWith("Dropped event"))).toHaveLength(2);
    await sup.stop();
  });

  it("keeps only the engine's own runs on a resync", async () => {
    const db = seededDb();
    const runs: string[] = [];
    engine.runs = [runState, { ...runState, id: OTHER_RUN, projectId: OTHER_PROJECT }];
    const sup = new EngineSupervisor({
      engines: {
        list: async () => [
          {
            container: CONTAINER,
            projectId: PROJECT_ID,
            hostPort: engine.port,
            token: ENGINE_TOKEN,
          },
        ],
      },
      db,
      expectedVersion: "1.0.0-dev",
      relay: () => undefined,
      decideLease: async () => {
        throw new Error("unused");
      },
      onRuns: (list) => runs.push(...list.map((r) => r.id)),
      intervalMs: 50,
    });
    sup.start();
    await waitFor(() => runs.length > 0);
    expect(runs).toEqual([RUN]);
    await sup.stop();
  });
});
