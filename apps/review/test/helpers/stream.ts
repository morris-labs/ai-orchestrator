// The scripted event stream: loads `fixtures/demo-run.jsonl` and plays it
// through a WebSocket double.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventSchema, type AgentBoxEvent } from "@agentbox/contracts";
import type { WebSocketLike } from "../../src/lib/events.js";

export function loadDemoEvents(): AgentBoxEvent[] {
  // jsdom replaces the global URL, so resolve from the file path instead.
  const file = resolve(dirname(fileURLToPath(import.meta.url)), "../../fixtures/demo-run.jsonl");
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => EventSchema.parse(JSON.parse(line)));
}

export class MockSocket implements WebSocketLike {
  static instances: MockSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {
    MockSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  deliver(frame: unknown) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  /** Sends the server hello, then every event in order. */
  replay(events: readonly AgentBoxEvent[], streamId = "server-demo-1") {
    this.deliver({ type: "hello", streamId, lastSeq: 0, replaying: false });
    for (const e of events) this.deliver(e);
  }

  close() {
    this.readyState = 3;
    this.onclose?.({});
  }

  static reset() {
    MockSocket.instances = [];
  }
}
