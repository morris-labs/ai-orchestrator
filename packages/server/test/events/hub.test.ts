import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { EventHub } from "../../src/events/hub.js";
import { LateSink } from "../../src/events/late-sink.js";
import { RunMirror } from "../../src/events/run-mirror.js";
import { RUN, runState } from "../api/fixtures.js";

const box = (id: string) => ({ type: "box.changed", boxId: id, status: "running", box: null }) as const;

describe("EventHub", () => {
  it("numbers server events and sets sourceSeq to seq", () => {
    const hub = new EventHub();
    const a = hub.emit(box("claude-agent-a"));
    const b = hub.emit(box("claude-agent-b"));
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(b).toMatchObject({ source: "server", sourceSeq: 2, streamId: hub.streamId });
  });

  it("re-numbers relayed engine events and keeps their source and number", () => {
    const hub = new EventHub();
    hub.emit(box("claude-agent-a"));
    const relayed = hub.relay({
      ...box("claude-agent-x"),
      id: "engine-id",
      time: "2026-10-28T09:00:00.000Z",
      source: "engine:claude-agent-proj-x",
      streamId: "engine-stream",
      seq: 41,
      sourceSeq: 41,
    });
    expect(relayed).toMatchObject({ id: "engine-id", seq: 2, sourceSeq: 41, source: "engine:claude-agent-proj-x", streamId: hub.streamId });
  });

  it("rejects an invalid event", () => {
    const hub = new EventHub();
    expect(() => hub.emit({ type: "box.changed", boxId: "", status: "running", box: null })).toThrow();
    expect(hub.lastSeq).toBe(0);
  });

  it("keeps notifying when a listener throws", () => {
    const errors: unknown[] = [];
    const hub = new EventHub({ onListenerError: (e) => errors.push(e) });
    const seen: number[] = [];
    hub.subscribe(() => {
      throw new Error("boom");
    });
    const off = hub.subscribe((e) => seen.push(e.seq));
    hub.emit(box("claude-agent-a"));
    off();
    hub.emit(box("claude-agent-b"));
    expect(seen).toEqual([1]);
    expect(errors).toHaveLength(2);
  });

  it("replays from memory, and refuses a gap or a foreign stream", () => {
    const hub = new EventHub({ bufferSize: 2 });
    for (const id of ["a", "b", "c"]) hub.emit(box(`claude-agent-${id}`));
    expect(hub.replay({ type: "hello", streamId: hub.streamId, lastSeq: 1 }).events.map((e) => e.seq)).toEqual([2, 3]);
    expect(hub.replay({ type: "hello", streamId: hub.streamId, lastSeq: 0 }).hello.replaying).toBe(false);
    expect(hub.replay({ type: "hello", streamId: hub.streamId, lastSeq: 3 })).toMatchObject({ hello: { replaying: true }, events: [] });
    expect(hub.replay({ type: "hello", streamId: hub.streamId, lastSeq: 9 }).hello.replaying).toBe(false);
    expect(hub.replay({ type: "hello", streamId: "other", lastSeq: 1 }).hello.replaying).toBe(false);
    expect(hub.replay({ type: "hello", streamId: null, lastSeq: null }).hello).toEqual({
      type: "hello",
      streamId: hub.streamId,
      lastSeq: 3,
      replaying: false,
    });
  });

  it("keeps the stream id and replays from SQLite across a restart", () => {
    const db = new Database(":memory:");
    const first = new EventHub({ db });
    for (const id of ["a", "b", "c"]) first.emit(box(`claude-agent-${id}`));
    const second = new EventHub({ db, bufferSize: 1 });
    expect(second.streamId).toBe(first.streamId);
    expect(second.lastSeq).toBe(3);
    expect(second.emit(box("claude-agent-d")).seq).toBe(4);
    expect(second.replay({ type: "hello", streamId: first.streamId, lastSeq: 1 }).events.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it("prunes SQLite to the configured size", () => {
    const db = new Database(":memory:");
    const hub = new EventHub({ db, keep: 10, bufferSize: 5 });
    for (let i = 0; i < 1000; i += 1) hub.emit(box(`claude-agent-${i}`));
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM svc_events").get() as { n: number };
    expect(n).toBe(10);
    expect(hub.replay({ type: "hello", streamId: hub.streamId, lastSeq: 900 }).hello.replaying).toBe(false);
  });
});

describe("LateSink", () => {
  it("holds events until the hub is attached", () => {
    const sink = new LateSink();
    sink.emit(box("claude-agent-a"));
    const hub = new EventHub();
    sink.attach(hub);
    expect(hub.lastSeq).toBe(1);
    expect(sink.emit(box("claude-agent-b")).seq).toBe(2);
  });
});

describe("RunMirror", () => {
  it("stores runs, keeps the newest state, and finds the active run of a box", () => {
    const mirror = new RunMirror(new Database(":memory:"));
    mirror.upsert(runState);
    mirror.upsert({ ...runState, status: "finished", updatedAt: "2026-10-28T08:00:00.000Z" });
    expect(mirror.get(RUN)?.status).toBe("running");
    expect(mirror.activeRunForBox(runState.boxId!)).toBe(RUN);
    mirror.ingest({
      type: "run.changed",
      run: { ...runState, status: "finished", updatedAt: "2026-10-28T10:00:00.000Z" },
      roundSummary: null,
      id: "x",
      time: "2026-10-28T10:00:00.000Z",
      source: "server",
      streamId: "s",
      seq: 1,
      sourceSeq: 1,
    });
    expect(mirror.activeRunForBox(runState.boxId!)).toBeNull();
    expect(mirror.list({ projectId: runState.projectId, status: "finished" })).toHaveLength(1);
    expect(mirror.list({ boxId: "claude-agent-none" })).toHaveLength(0);
    expect(mirror.round(RUN)).toBe(1);
    expect(mirror.round("01JB8Z5K3W6Q2V9X4T7R0M1N2Q")).toBe(0);
  });
});
