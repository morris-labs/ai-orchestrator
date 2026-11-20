import { openDatabase } from "../../src/db/index.js";
import { describe, expect, it } from "vitest";
import { FindingSchema } from "@aio/contracts";
import { EventHub } from "../../src/events/hub.js";
import { LateSink } from "../../src/events/late-sink.js";
import { RunMirror } from "../../src/events/run-mirror.js";
import { RUN, runState } from "../api/fixtures.js";

const box = (id: string) =>
  ({ type: "box.changed", boxId: id, status: "running", box: null }) as const;

describe("EventHub", () => {
  it("numbers server events and sets sourceSeq to seq", () => {
    const hub = new EventHub();
    const a = hub.emit(box("aio-agent-a"));
    const b = hub.emit(box("aio-agent-b"));
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(b).toMatchObject({ source: "server", sourceSeq: 2, streamId: hub.streamId });
  });

  it("re-numbers relayed engine events and keeps their source and number", () => {
    const hub = new EventHub();
    hub.emit(box("aio-agent-a"));
    const relayed = hub.relay({
      ...box("aio-agent-x"),
      id: "engine-id",
      time: "2026-10-28T09:00:00.000Z",
      source: "engine:aio-agent-proj-x",
      streamId: "engine-stream",
      seq: 41,
      sourceSeq: 41,
    });
    expect(relayed).toMatchObject({
      id: "engine-id",
      seq: 2,
      sourceSeq: 41,
      source: "engine:aio-agent-proj-x",
      streamId: hub.streamId,
    });
  });

  it("rejects an invalid event", () => {
    const hub = new EventHub();
    expect(() =>
      hub.emit({ type: "box.changed", boxId: "", status: "running", box: null }),
    ).toThrow();
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
    hub.emit(box("aio-agent-a"));
    off();
    hub.emit(box("aio-agent-b"));
    expect(seen).toEqual([1]);
    expect(errors).toHaveLength(2);
  });

  // A listener that emits in turn (the notifier answering a
  // run) made later listeners see the new event before the one that caused
  // it, and a stream socket then dropped the earlier one.
  it("delivers an event emitted by a listener after the one being delivered", () => {
    const hub = new EventHub();
    hub.subscribe((e) => {
      if (e.type === "box.changed" && e.boxId === "aio-agent-a") hub.emit(box("aio-agent-b"));
    });
    const seen: number[] = [];
    hub.subscribe((e) => seen.push(e.seq));
    const first = hub.emit(box("aio-agent-a"));
    expect(first.seq).toBe(1);
    expect(seen).toEqual([1, 2]);
    expect(hub.lastSeq).toBe(2);
  });

  it("replays from memory, and refuses a gap or a foreign stream", () => {
    const hub = new EventHub({ bufferSize: 2 });
    for (const id of ["a", "b", "c"]) hub.emit(box(`aio-agent-${id}`));
    expect(
      hub.replay({ type: "hello", streamId: hub.streamId, lastSeq: 1 }).events.map((e) => e.seq),
    ).toEqual([2, 3]);
    expect(hub.replay({ type: "hello", streamId: hub.streamId, lastSeq: 0 }).hello.replaying).toBe(
      false,
    );
    expect(hub.replay({ type: "hello", streamId: hub.streamId, lastSeq: 3 })).toMatchObject({
      hello: { replaying: true },
      events: [],
    });
    expect(hub.replay({ type: "hello", streamId: hub.streamId, lastSeq: 9 }).hello.replaying).toBe(
      false,
    );
    expect(hub.replay({ type: "hello", streamId: "other", lastSeq: 1 }).hello.replaying).toBe(
      false,
    );
    expect(hub.replay({ type: "hello", streamId: null, lastSeq: null }).hello).toEqual({
      type: "hello",
      streamId: hub.streamId,
      lastSeq: 3,
      replaying: false,
    });
  });

  it("keeps the stream id and replays from SQLite across a restart", () => {
    const db = openDatabase(":memory:");
    const first = new EventHub({ db });
    for (const id of ["a", "b", "c"]) first.emit(box(`aio-agent-${id}`));
    const second = new EventHub({ db, bufferSize: 1 });
    expect(second.streamId).toBe(first.streamId);
    expect(second.lastSeq).toBe(3);
    expect(second.emit(box("aio-agent-d")).seq).toBe(4);
    expect(
      second
        .replay({ type: "hello", streamId: first.streamId, lastSeq: 1 })
        .events.map((e) => e.seq),
    ).toEqual([2, 3, 4]);
  });

  it("prunes SQLite to the configured size", () => {
    const db = openDatabase(":memory:");
    const hub = new EventHub({ db, keep: 10, bufferSize: 5 });
    for (let i = 0; i < 1000; i += 1) hub.emit(box(`aio-agent-${i}`));
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM svc_events").get() as { n: number };
    expect(n).toBe(10);
    expect(
      hub.replay({ type: "hello", streamId: hub.streamId, lastSeq: 900 }).hello.replaying,
    ).toBe(false);
  });
});

describe("EventHub filtered streams", () => {
  const only = new Set(["box.changed"] as const);
  it("numbers the filtered stream by position and replays without gaps", () => {
    const hub = new EventHub();
    hub.emit(box("aio-agent-a"));
    hub.emit(note());
    hub.emit(box("aio-agent-b"));
    const id = hub.filteredStreamId(only);
    expect(id).not.toBe(hub.streamId);
    expect(hub.filteredStreamId(null)).toBe(hub.streamId);
    expect(hub.filteredLastSeq(only)).toBe(2);
    const plan = hub.replay({ type: "hello", streamId: id, lastSeq: 0 }, only);
    expect(plan.hello).toEqual({ type: "hello", streamId: id, lastSeq: 2, replaying: true });
    expect(plan.events.map((e) => [e.seq, e.streamId, "boxId" in e && e.boxId])).toEqual([
      [1, id, "aio-agent-a"],
      [2, id, "aio-agent-b"],
    ]);
    // The hub's own position means nothing on the filtered stream.
    expect(
      hub.replay({ type: "hello", streamId: hub.streamId, lastSeq: 3 }, only).hello.replaying,
    ).toBe(false);
    expect(hub.replay({ type: "hello", streamId: id, lastSeq: 3 }, only).hello.replaying).toBe(
      false,
    );
  });

  it("keeps the filtered numbering across a restart and a prune", () => {
    const db = openDatabase(":memory:");
    const first = new EventHub({ db, keep: 10, bufferSize: 5 });
    for (let i = 0; i < 1005; i += 1) {
      first.emit(i % 2 === 0 ? box(`aio-agent-${i}`) : note());
    }
    const boxes = first.filteredLastSeq(only);
    expect(boxes).toBe(503);
    const second = new EventHub({ db, keep: 10, bufferSize: 5 });
    expect(second.filteredLastSeq(only)).toBe(boxes);
    expect(second.filteredStreamId(only)).toBe(first.filteredStreamId(only));
    const id = second.filteredStreamId(only);
    const plan = second.replay({ type: "hello", streamId: id, lastSeq: boxes - 3 }, only);
    expect(plan.hello.replaying).toBe(true);
    expect(plan.events.map((e) => e.seq)).toEqual([boxes - 2, boxes - 1, boxes]);
    expect(plan.events.map((e) => e.sourceSeq)).toEqual([1001, 1003, 1005]);
    // Further back than SQLite keeps: the client must reload.
    expect(
      second.replay({ type: "hello", streamId: id, lastSeq: boxes - 50 }, only).hello.replaying,
    ).toBe(false);
  });
});

function note() {
  return {
    type: "notification",
    notificationId: "n",
    kind: "box_ended",
    title: "Box ended",
    body: "",
    runId: null,
    boxId: null,
    severity: "warning",
    read: false,
  } as const;
}

describe("LateSink", () => {
  it("holds events until the hub is attached", () => {
    const sink = new LateSink();
    sink.emit(box("aio-agent-a"));
    const hub = new EventHub();
    sink.attach(hub);
    expect(hub.lastSeq).toBe(1);
    expect(sink.emit(box("aio-agent-b")).seq).toBe(2);
  });
});

describe("RunMirror", () => {
  it("stores runs, keeps the newest state, and finds the active run of a box", () => {
    const mirror = new RunMirror(openDatabase(":memory:"));
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
    expect(mirror.list({ boxId: "aio-agent-none" })).toHaveLength(0);
    expect(mirror.round(RUN)).toBe(1);
    expect(mirror.round("01JB8Z5K3W6Q2V9X4T7R0M1N2Q")).toBe(0);
  });

  it("keeps the latest state of each finding from finding.changed events", () => {
    const db = openDatabase(":memory:");
    const mirror = new RunMirror(db);
    const finding = FindingSchema.parse({
      id: "F-0001",
      fingerprint: "3f786850e387550fdab836ed7e6dc881de23001b",
      severity: "P1",
      title: "Retry loop never gives up on a closed socket",
      file: "src/mailer.ts",
      lines: [120, 134],
      failureCase: "A closed SMTP socket makes send() retry forever.",
      category: "correctness",
      introduced: true,
      reportedBy: "codex-gpt-5",
      alsoReportedBy: [],
      verdict: "pending",
      verification: "code-reading",
      evidence: "",
      runId: RUN,
      round: 1,
      groupId: "G-01",
      hunkIds: ["H-0003"],
      origin: "reviewer",
      history: [],
    });
    const event = (f: typeof finding, seq: number) =>
      ({
        type: "finding.changed",
        runId: RUN,
        finding: f,
        previousVerdict: null,
        id: `e${seq}`,
        time: "2026-10-28T10:00:00.000Z",
        source: "engine:aio-agent-proj-x",
        streamId: "s",
        seq,
        sourceSeq: seq,
      }) as const;
    mirror.ingest(event(finding, 1));
    mirror.ingest(event({ ...finding, verdict: "confirmed" }, 2));
    mirror.ingest(event({ ...finding, id: "F-0002", verdict: "disproved" }, 3));
    expect(mirror.findings(RUN).map((f) => [f.id, f.verdict])).toEqual([
      ["F-0001", "confirmed"],
      ["F-0002", "disproved"],
    ]);
    expect(mirror.findings("01JB8Z5K3W6Q2V9X4T7R0M1N2Q")).toEqual([]);
    // A server can serve a mirrored run before its engine reconnects.
    db.prepare(
      "UPDATE svc_findings SET verdict = ?, json = ? WHERE run_id = ? AND finding_id = ?",
    ).run(
      "pre-existing",
      JSON.stringify({ ...finding, verdict: "pre-existing", introduced: false }),
      RUN,
      finding.id,
    );
    expect(mirror.findings(RUN)[0]).toMatchObject({
      verdict: "confirmed",
      introduced: false,
      history: expect.arrayContaining([expect.objectContaining({ verdict: "pre-existing" })]),
    });
  });
});
