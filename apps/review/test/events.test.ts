import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventClient, eventStreamUrl } from "../src/lib/events.js";
import { MockSocket, loadDemoEvents } from "./helpers/stream.js";

const events = loadDemoEvents();

function client(extra: Partial<ConstructorParameters<typeof EventClient>[0]> = {}) {
  const got: string[] = [];
  const resets: number[] = [];
  const invalid: string[] = [];
  const c = new EventClient({
    baseUrl: "http://127.0.0.1:20400",
    token: "t0k",
    socket: (url) => new MockSocket(url),
    onEvent: (e) => got.push(`${e.seq}:${e.type}`),
    onReset: () => resets.push(1),
    onInvalid: (_r, m) => invalid.push(m),
    backoff: [10],
    ...extra,
  });
  return { c, got, resets, invalid };
}

describe("eventStreamUrl", () => {
  it("builds a ws URL with types and token", () => {
    expect(eventStreamUrl("http://127.0.0.1:20400", "abc", ["run.changed", "notification"])).toBe(
      "ws://127.0.0.1:20400/api/v1/events?types=run.changed%2Cnotification&token=abc",
    );
    expect(eventStreamUrl("https://h", null)).toBe("wss://h/api/v1/events");
  });
});

describe("EventClient", () => {
  beforeEach(() => MockSocket.reset());
  afterEach(() => vi.useRealTimers());

  it("sends a first hello and dispatches every event of the demo", () => {
    const { c, got } = client();
    c.start();
    const ws = MockSocket.instances[0]!;
    ws.open();
    expect(ws.sent[0]).toEqual({ type: "hello", streamId: null, lastSeq: null });
    ws.replay(events);
    expect(got).toHaveLength(events.length);
    expect(c.position).toEqual({ streamId: "server-demo-1", seq: events.length });
  });

  it("drops duplicates and invalid frames", () => {
    const { c, got, invalid } = client();
    c.start();
    const ws = MockSocket.instances[0]!;
    ws.open();
    ws.replay(events.slice(0, 3));
    ws.deliver(events[1]);
    ws.deliver("not json");
    ws.deliver({ type: "stage.changed", seq: 9 });
    expect(got).toHaveLength(3);
    expect(invalid).toHaveLength(2);
  });

  it("resumes after a reconnect and resets when the stream changed", () => {
    vi.useFakeTimers();
    const { c, got, resets } = client();
    c.start();
    let ws = MockSocket.instances[0]!;
    ws.open();
    ws.replay(events.slice(0, 4));
    ws.close();
    vi.advanceTimersByTime(20);
    ws = MockSocket.instances[1]!;
    ws.open();
    expect(ws.sent[0]).toEqual({ type: "hello", streamId: "server-demo-1", lastSeq: 4 });
    ws.deliver({ type: "hello", streamId: "server-demo-1", lastSeq: 6, replaying: true });
    ws.deliver(events[4]);
    expect(resets).toEqual([]);
    expect(got).toHaveLength(5);

    ws.close();
    vi.advanceTimersByTime(20);
    ws = MockSocket.instances[2]!;
    ws.open();
    ws.deliver({ type: "hello", streamId: "server-restarted", lastSeq: 2, replaying: false });
    expect(resets).toEqual([1]);
    c.stop();
  });

  it("stops reconnecting after stop()", () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const { c } = client({ onState: (s) => states.push(s) });
    c.start();
    MockSocket.instances[0]!.open();
    c.stop();
    vi.advanceTimersByTime(100);
    expect(MockSocket.instances).toHaveLength(1);
    expect(states).toEqual(["connecting", "open", "closed"]);
  });
});
