// The server event stream: numbers every event the server emits or relays,
// keeps a replay buffer in memory and a mirror in SQLite, and fans events out
// to in-process listeners and to `events.stream` clients.
//
// The stream id survives a server restart as long as the SQLite mirror does,
// so a client can resume across restarts. A client that asks for events
// older than the mirror keeps gets `replaying: false` and reloads.
import { randomUUID } from "node:crypto";
import {
  EventSchema,
  type AgentBoxEvent,
  type ClientHello,
  type StreamHello,
} from "@agentbox/contracts";
import type { EventInput, EventSink, SqlDatabase } from "../api/core-interface.js";

export type EventListener = (event: AgentBoxEvent) => void;

export interface EventHubOptions {
  /** The SQLite mirror; without it the stream lives in memory only. */
  db?: SqlDatabase;
  /** Events kept in memory for replay. */
  bufferSize?: number;
  /** Events kept in SQLite. */
  keep?: number;
  now?: () => Date;
  /** Receives a listener's exception; the hub carries on. */
  onListenerError?: (err: unknown, event: AgentBoxEvent) => void;
}

/** What a client receives first: the hello frame and the events to replay. */
export interface ReplayPlan {
  hello: StreamHello;
  events: AgentBoxEvent[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS svc_event_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS svc_events (seq INTEGER PRIMARY KEY, type TEXT NOT NULL, json TEXT NOT NULL);
`;

export class EventHub implements EventSink {
  readonly streamId: string;
  private seq: number;
  private readonly buffer: AgentBoxEvent[] = [];
  private readonly listeners = new Set<EventListener>();
  private readonly bufferSize: number;
  private readonly keep: number;
  private insertsSincePrune = 0;

  constructor(private readonly options: EventHubOptions = {}) {
    this.bufferSize = options.bufferSize ?? 5000;
    this.keep = options.keep ?? 50_000;
    const db = options.db;
    if (db) {
      db.exec(SCHEMA);
      const row = db.prepare("SELECT value FROM svc_event_meta WHERE key = 'streamId'").get() as
        { value: string } | undefined;
      const max = db.prepare("SELECT MAX(seq) AS seq FROM svc_events").get() as {
        seq: number | null;
      };
      if (row) {
        this.streamId = row.value;
        this.seq = max.seq ?? 0;
      } else {
        this.streamId = randomUUID();
        this.seq = 0;
        db.prepare("DELETE FROM svc_events").run();
        db.prepare("INSERT INTO svc_event_meta (key, value) VALUES ('streamId', ?)").run(
          this.streamId,
        );
      }
    } else {
      this.streamId = randomUUID();
      this.seq = 0;
    }
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Emits an event the server produces itself. */
  emit(input: EventInput): AgentBoxEvent {
    const seq = this.seq + 1;
    const event = {
      ...input,
      id: randomUUID(),
      time: (this.options.now?.() ?? new Date()).toISOString(),
      source: "server",
      streamId: this.streamId,
      seq,
      sourceSeq: seq,
    };
    return this.publish(event);
  }

  /**
   * Relays an engine event: keeps its id, time, and source, re-numbers `seq`,
   * and keeps the engine's number in `sourceSeq`.
   */
  relay(event: AgentBoxEvent): AgentBoxEvent {
    return this.publish({
      ...event,
      streamId: this.streamId,
      seq: this.seq + 1,
      sourceSeq: event.seq,
    });
  }

  private publish(candidate: unknown): AgentBoxEvent {
    const event = EventSchema.parse(candidate);
    this.seq = event.seq;
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    this.persist(event);
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        this.options.onListenerError?.(err, event);
      }
    }
    return event;
  }

  private persist(event: AgentBoxEvent): void {
    const db = this.options.db;
    if (!db) return;
    db.prepare("INSERT INTO svc_events (seq, type, json) VALUES (?, ?, ?)").run(
      event.seq,
      event.type,
      JSON.stringify(event),
    );
    this.insertsSincePrune += 1;
    if (this.insertsSincePrune >= 1000) {
      this.insertsSincePrune = 0;
      db.prepare("DELETE FROM svc_events WHERE seq <= ?").run(this.seq - this.keep);
    }
  }

  /** Adds a listener for every later event; returns the function that removes it. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Answers a client's hello: replays every event after the client's
   * `lastSeq` when its `streamId` matches and the events are still kept.
   */
  replay(hello: ClientHello): ReplayPlan {
    const none: ReplayPlan = {
      hello: { type: "hello", streamId: this.streamId, lastSeq: this.seq, replaying: false },
      events: [],
    };
    if (hello.streamId !== this.streamId || hello.lastSeq === null) return none;
    const from = hello.lastSeq;
    if (from > this.seq) return none;
    if (from === this.seq) return { ...none, hello: { ...none.hello, replaying: true } };
    const events = this.eventsAfter(from);
    if (events === null) return none;
    return { hello: { ...none.hello, replaying: true }, events };
  }

  /** Every kept event after `seq`, or `null` when some of them are gone. */
  private eventsAfter(seq: number): AgentBoxEvent[] | null {
    const first = this.buffer[0];
    if (first && first.seq <= seq + 1) return this.buffer.filter((e) => e.seq > seq);
    const db = this.options.db;
    if (!db) return null;
    const rows = db
      .prepare("SELECT seq, json FROM svc_events WHERE seq > ? ORDER BY seq")
      .all(seq) as { seq: number; json: string }[];
    if (rows.length === 0 || rows[0]?.seq !== seq + 1) return null;
    return rows.map((r) => EventSchema.parse(JSON.parse(r.json)));
  }
}
