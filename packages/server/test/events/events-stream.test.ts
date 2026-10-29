import { ServerStreamFrameSchema } from "@agentbox/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTypes } from "../../src/api/server.js";
import { TOKEN, createHarness, type Harness } from "../api/harness.js";
import { connect } from "../api/ws-client.js";

let h: Harness;
let base: string;
beforeEach(async () => {
  h = await createHarness();
  const port = await h.server.listen(0);
  base = `ws://127.0.0.1:${port}/api/v1/events`;
});
afterEach(async () => {
  await h.server.close();
});

const boxEvent = (boxId: string) =>
  ({ type: "box.changed", boxId, status: "running", box: null }) as const;

describe("events.stream", () => {
  it("refuses a socket without the token", async () => {
    await expect(connect(base)).rejects.toThrow("HTTP 401");
  });

  it("accepts the session cookie", async () => {
    const { sessionValue } = await import("../../src/api/auth.js");
    const s = await connect(base, { cookie: `agentbox_session=${sessionValue(TOKEN)}` });
    s.ws.close();
  });

  it("sends hello, then live events numbered in order", async () => {
    h.hub.emit(boxEvent("claude-agent-a"));
    const s = await connect(`${base}?token=${TOKEN}`);
    s.ws.send(JSON.stringify({ type: "hello", streamId: null, lastSeq: null }));
    await s.until((x) => x.texts.length === 1);
    expect(s.texts[0]).toEqual({
      type: "hello",
      streamId: h.hub.streamId,
      lastSeq: 1,
      replaying: false,
    });
    h.hub.emit(boxEvent("claude-agent-b"));
    await s.until((x) => x.texts.length === 2);
    const event = ServerStreamFrameSchema.parse(s.texts[1]);
    expect(event).toMatchObject({ type: "box.changed", seq: 2, sourceSeq: 2, source: "server" });
    s.ws.close();
  });

  it("replays events after the client's lastSeq when the stream id matches", async () => {
    for (const id of ["a", "b", "c"]) h.hub.emit(boxEvent(`claude-agent-${id}`));
    const s = await connect(`${base}?token=${TOKEN}`);
    s.ws.send(JSON.stringify({ type: "hello", streamId: h.hub.streamId, lastSeq: 1 }));
    await s.until((x) => x.texts.length === 3);
    expect(s.texts[0]).toMatchObject({ type: "hello", replaying: true, lastSeq: 3 });
    expect((s.texts.slice(1) as { seq: number }[]).map((e) => e.seq)).toEqual([2, 3]);
    h.hub.emit(boxEvent("claude-agent-d"));
    await s.until((x) => x.texts.length === 4);
    expect((s.texts[3] as { seq: number }).seq).toBe(4);
    s.ws.close();
  });

  it("replays nothing for another stream id, and resyncs on a second hello", async () => {
    h.hub.emit(boxEvent("claude-agent-a"));
    const s = await connect(`${base}?token=${TOKEN}`);
    s.ws.send(JSON.stringify({ type: "hello", streamId: "old-stream", lastSeq: 9 }));
    await s.until((x) => x.texts.length === 1);
    expect(s.texts[0]).toMatchObject({ replaying: false, lastSeq: 1 });
    s.ws.send(JSON.stringify({ type: "hello", streamId: h.hub.streamId, lastSeq: 0 }));
    await s.until((x) => x.texts.length === 3);
    expect(s.texts[1]).toMatchObject({ type: "hello", replaying: true });
    expect(s.texts[2]).toMatchObject({ seq: 1 });
    s.ws.close();
  });

  it("filters by type", async () => {
    const s = await connect(`${base}?token=${TOKEN}&types=notification`);
    s.ws.send(JSON.stringify({ type: "hello", streamId: null, lastSeq: null }));
    await s.until((x) => x.texts.length === 1);
    h.hub.emit(boxEvent("claude-agent-a"));
    h.hub.emit({
      type: "notification",
      notificationId: "n1",
      kind: "box_ended",
      title: "Box ended",
      body: "",
      runId: null,
      boxId: null,
      severity: "warning",
      read: false,
    });
    await s.until((x) => x.texts.length === 2);
    expect(s.texts[1]).toMatchObject({ type: "notification", seq: 1 });
    s.ws.close();
  });

  // Finding 17: a filtered stream used to keep the hub's `seq`, so every
  // event of another type left a gap. The client's gap check sent a hello,
  // the replay had the same gap, and the client stalled.
  it("numbers a filtered stream without gaps, live and on replay", async () => {
    const note = (id: string) =>
      ({
        type: "notification",
        notificationId: id,
        kind: "box_ended",
        title: "Box ended",
        body: "",
        runId: null,
        boxId: null,
        severity: "warning",
        read: false,
      }) as const;
    const url = `${base}?token=${TOKEN}&types=notification`;
    // The same check `EventsConnection` makes: each event must follow the last.
    const gapless = (frames: unknown[], from: number) => {
      let last = from;
      for (const f of frames as { seq: number }[]) {
        expect(f.seq).toBe(last + 1);
        last = f.seq;
      }
      return last;
    };
    h.hub.emit(boxEvent("claude-agent-a"));
    h.hub.emit(note("n1"));
    const s = await connect(url);
    s.ws.send(JSON.stringify({ type: "hello", streamId: null, lastSeq: null }));
    await s.until((x) => x.texts.length === 1);
    const hello = s.texts[0] as { streamId: string; lastSeq: number };
    expect(hello).toMatchObject({ replaying: false, lastSeq: 1 });
    expect(hello.streamId).not.toBe(h.hub.streamId);
    h.hub.emit(boxEvent("claude-agent-b"));
    h.hub.emit(note("n2"));
    h.hub.emit(boxEvent("claude-agent-c"));
    h.hub.emit(note("n3"));
    await s.until((x) => x.texts.length === 3);
    const live = s.texts.slice(1) as { streamId: string; seq: number }[];
    expect(live.every((e) => e.streamId === hello.streamId)).toBe(true);
    expect(gapless(live, hello.lastSeq)).toBe(3);
    s.ws.close();

    // A reconnect resumes from the filtered position and replays only what it missed.
    h.hub.emit(boxEvent("claude-agent-d"));
    h.hub.emit(note("n4"));
    const r = await connect(url);
    r.ws.send(JSON.stringify({ type: "hello", streamId: hello.streamId, lastSeq: 2 }));
    await r.until((x) => x.texts.length === 3);
    expect(r.texts[0]).toMatchObject({ replaying: true, lastSeq: 4, streamId: hello.streamId });
    const replayed = r.texts.slice(1) as { notificationId: string; seq: number }[];
    expect(replayed.map((e) => e.notificationId)).toEqual(["n3", "n4"]);
    expect(gapless(replayed, 2)).toBe(4);
    h.hub.emit(note("n5"));
    await r.until((x) => x.texts.length === 4);
    expect(r.texts[3]).toMatchObject({ notificationId: "n5", seq: 5 });
    r.ws.close();
  });

  it("closes on a frame that is not a hello", async () => {
    const s = await connect(`${base}?token=${TOKEN}`);
    s.ws.send("nonsense");
    expect((await s.closed).code).toBe(1008);
  });

  it("closes on an unknown event type", async () => {
    const s = await connect(`${base}?token=${TOKEN}&types=bogus`);
    expect((await s.closed).code).toBe(1008);
  });

  it("parses the types query", () => {
    expect(parseTypes(undefined)).toBeNull();
    expect([...(parseTypes("box.changed, notification") ?? [])]).toEqual([
      "box.changed",
      "notification",
    ]);
    expect(() => parseTypes("nope")).toThrow();
  });
});
