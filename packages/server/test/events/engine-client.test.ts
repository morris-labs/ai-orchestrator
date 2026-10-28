import type { AgentBoxEvent, LeaseRequest } from "@agentbox/contracts";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineClient, type StreamCursor } from "../../src/events/engine-client.js";
import { EngineSupervisor, sqliteCursor } from "../../src/events/engines.js";
import { CONTAINER, PROJECT_ID, RUN, runState } from "../api/fixtures.js";
import { ENGINE_TOKEN, FakeEngineServer, waitFor } from "./fake-engine.js";

let engine: FakeEngineServer;
let client: EngineClient | null;
let received: AgentBoxEvent[];
let resyncs: number;
let cursor: StreamCursor;

const runEvent = { type: "run.changed", run: runState, roundSummary: null } as const;

function build(overrides: Partial<ConstructorParameters<typeof EngineClient>[0]> = {}) {
  client = new EngineClient({
    endpoint: { container: CONTAINER, projectId: PROJECT_ID, hostPort: engine.port, token: ENGINE_TOKEN },
    expectedVersion: "4.0.0-dev",
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
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE svc_engine_cursors (container TEXT PRIMARY KEY, stream_id TEXT NOT NULL, last_seq INTEGER NOT NULL)",
  );
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
    expect(c.info).toEqual({ hostPort: engine.port, version: "4.0.0-dev", healthy: true, versionMatches: true });
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

  it("calls engine routes with the token and validates responses", async () => {
    const c = build();
    expect(await c.call("engine.runs.get", { params: { runId: RUN } })).toEqual(runState);
    await expect(c.call("engine.runs.get", { params: { runId: "01JB8Z5K3W6Q2V9X4T7R0M1N2Q" } })).rejects.toMatchObject({
      code: "run_not_found",
      status: 404,
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
        return { decision: "pause", leaseId: req.leaseId, resumeAt: "2026-10-28T10:00:00.000Z", reason: "ceiling" };
      },
    });
    c.start();
    await waitFor(() => engine.sockets.length === 1);
    engine.sendRaw({ type: "lease.request", leaseId: "L-1", runId: RUN, vendor: "claude", role: "fixer", estimate: { tokens: 10 } });
    await waitFor(() => engine.leaseResponses.length === 1);
    expect(requests[0]).toEqual({ leaseId: "L-1", runId: RUN, vendor: "claude", role: "fixer", estimate: { tokens: 10 } });
    expect(engine.leaseResponses[0]).toMatchObject({ decision: "pause", leaseId: "L-1" });
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
    const db = new Database(":memory:");
    const relayed: AgentBoxEvent[] = [];
    const runs: unknown[] = [];
    let endpoints = [{ container: CONTAINER, projectId: PROJECT_ID, hostPort: engine.port, token: ENGINE_TOKEN }];
    const sup = new EngineSupervisor({
      engines: { list: async () => endpoints },
      db,
      expectedVersion: "4.0.0-dev",
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
    engine.sendRaw({ type: "lease.request", leaseId: "L-2", runId: RUN, vendor: "codex", role: "reviewer", estimate: { tokens: 1 } });
    await waitFor(() => engine.leaseResponses.length === 1);
    expect(engine.leaseResponses[0]).toMatchObject({ decision: "deny", reason: `${CONTAINER}/${PROJECT_ID}` });
    endpoints = [];
    await sup.refresh();
    expect(sup.get(CONTAINER)).toBeUndefined();
    expect(() => sup.requireProject(PROJECT_ID)).toThrow(expect.objectContaining({ code: "conflict" }));
    await sup.stop();
  });
});
