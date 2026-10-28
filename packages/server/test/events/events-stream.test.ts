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
    expect(s.texts[0]).toEqual({ type: "hello", streamId: h.hub.streamId, lastSeq: 1, replaying: false });
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
    expect(s.texts[1]).toMatchObject({ type: "notification", seq: 2 });
    s.ws.close();
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
    expect([...(parseTypes("box.changed, notification") ?? [])]).toEqual(["box.changed", "notification"]);
    expect(() => parseTypes("nope")).toThrow();
  });
});
