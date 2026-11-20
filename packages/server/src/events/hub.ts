// The server event stream: numbers every event the server emits or relays,
// keeps a replay buffer in memory and a mirror in SQLite, and fans events out
// to in-process listeners and to `events.stream` clients.
//
// The stream id survives a server restart as long as the SQLite mirror does,
// so a client can resume across restarts. A client that asks for events
// older than the mirror keeps gets `replaying: false` and reloads.
//
// A client that subscribes to some event types only reads a stream of its
// own: the contract defines `seq` as the position in the stream you are
// reading, so a filtered stream numbers its events 1, 2, 3, ... without the
// gaps the other types would leave. The hub counts the events of each type,
// so that number is the same on every connection and across restarts, and a
// filtered client can resume like any other.
import { createHash, randomUUID } from "node:crypto";
import {
  EventSchema,
  adaptLegacyFinding,
  type AioEvent,
  type ClientHello,
  type EventType,
  type StreamHello,
} from "@aio/contracts";
import type { EventInput, EventSink, SqlDatabase } from "../api/core-interface.js";

/** Applies finding compatibility when replaying events from an earlier server. */
function parseStoredEvent(json: string): AioEvent {
  const value: unknown = JSON.parse(json);
  if (value && typeof value === "object" && "type" in value && value.type === "finding.changed") {
    const event = value as { finding: unknown };
    return EventSchema.parse({
      ...value,
      finding: adaptLegacyFinding(event.finding),
    });
  }
  return EventSchema.parse(value);
}

export type EventListener = (event: AioEvent) => void;

export interface EventHubOptions {
  /** The SQLite mirror; without it the stream lives in memory only. */
  db?: SqlDatabase;
  /** Events kept in memory for replay. */
  bufferSize?: number;
  /** Events kept in SQLite. */
  keep?: number;
  now?: () => Date;
  /** Receives a listener's exception; the hub carries on. */
  onListenerError?: (err: unknown, event: AioEvent) => void;
}

/** What a client receives first: the hello frame and the events to replay. */
export interface ReplayPlan {
  hello: StreamHello;
  events: AioEvent[];
}

/** The event types a client reads, or `null` for all of them. */
export type EventFilter = ReadonlySet<EventType> | null;

/** The `svc_event_meta` key that holds the per-type counts. */
const COUNTS_KEY = "typeCounts";

interface StoredCounts {
  /** The hub `seq` the counts include. */
  through: number;
  counts: Record<string, number>;
}

export class EventHub implements EventSink {
  readonly streamId: string;
  private seq: number;
  /** How many events of each type the stream holds, from its first event. */
  private readonly typeCounts = new Map<string, number>();
  private readonly buffer: AioEvent[] = [];
  private readonly listeners = new Set<EventListener>();
  private readonly bufferSize: number;
  private readonly keep: number;
  private insertsSincePrune = 0;
  /** Events numbered while listeners were running, waiting their turn. */
  private readonly undelivered: AioEvent[] = [];
  private delivering = false;

  constructor(private readonly options: EventHubOptions = {}) {
    this.bufferSize = options.bufferSize ?? 5000;
    this.keep = options.keep ?? 50_000;
    const db = options.db;
    if (db) {
      const row = db.prepare("SELECT value FROM svc_event_meta WHERE key = 'streamId'").get() as
        { value: string } | undefined;
      const max = db.prepare("SELECT MAX(seq) AS seq FROM svc_events").get() as {
        seq: number | null;
      };
      if (row) {
        this.streamId = row.value;
        this.seq = max.seq ?? 0;
        this.loadCounts(db);
      } else {
        this.streamId = randomUUID();
        this.seq = 0;
        db.prepare("DELETE FROM svc_events").run();
        db.prepare("DELETE FROM svc_event_meta WHERE key = ?").run(COUNTS_KEY);
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

  /**
   * Reads the stored per-type counts and adds the events stored after them.
   * The counts are saved before every prune, so every event they don't
   * include is still in `svc_events`.
   */
  private loadCounts(db: SqlDatabase): void {
    const row = db.prepare("SELECT value FROM svc_event_meta WHERE key = ?").get(COUNTS_KEY) as
      { value: string } | undefined;
    let stored: StoredCounts = { through: 0, counts: {} };
    if (row) {
      try {
        stored = JSON.parse(row.value) as StoredCounts;
      } catch {
        // A damaged row counts from what SQLite still keeps.
      }
    }
    for (const [type, n] of Object.entries(stored.counts)) this.typeCounts.set(type, n);
    const rows = db
      .prepare("SELECT type, COUNT(*) AS n FROM svc_events WHERE seq > ? GROUP BY type")
      .all(stored.through) as { type: string; n: number }[];
    for (const r of rows) this.typeCounts.set(r.type, (this.typeCounts.get(r.type) ?? 0) + r.n);
  }

  private saveCounts(db: SqlDatabase): void {
    const value: StoredCounts = { through: this.seq, counts: Object.fromEntries(this.typeCounts) };
    db.prepare(
      "INSERT INTO svc_event_meta (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(COUNTS_KEY, JSON.stringify(value));
  }

  /**
   * The id of the stream a client with `filter` reads: the hub's own id for
   * every type, and an id derived from it and the type list otherwise.
   */
  filteredStreamId(filter: EventFilter): string {
    if (filter === null) return this.streamId;
    const key = [...filter].sort().join(",");
    return `${this.streamId}.${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  }

  /** The newest `seq` of the stream a client with `filter` reads. */
  filteredLastSeq(filter: EventFilter): number {
    if (filter === null) return this.seq;
    let n = 0;
    for (const type of filter) n += this.typeCounts.get(type) ?? 0;
    return n;
  }

  /** Emits an event the server produces itself. */
  emit(input: EventInput): AioEvent {
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
  relay(event: AioEvent): AioEvent {
    return this.publish({
      ...event,
      streamId: this.streamId,
      seq: this.seq + 1,
      sourceSeq: event.seq,
    });
  }

  private publish(candidate: unknown): AioEvent {
    const event = EventSchema.parse(candidate);
    this.seq = event.seq;
    this.typeCounts.set(event.type, (this.typeCounts.get(event.type) ?? 0) + 1);
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) this.buffer.shift();
    this.persist(event);
    this.deliver(event);
    return event;
  }

  /**
   * Hands `event` to every listener, in `seq` order across all events. A
   * listener can emit in turn (the notifier answers a finished run with a
   * notification), and delivering that event at once would reach the
   * listeners after it before the event that caused it. A stream socket then
   * sees a higher `seq` first and drops the lower one as already sent. So an
   * event emitted during delivery waits until every listener has the one
   * before it.
   */
  private deliver(event: AioEvent): void {
    this.undelivered.push(event);
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (let next = this.undelivered.shift(); next; next = this.undelivered.shift()) {
        for (const listener of [...this.listeners]) {
          try {
            listener(next);
          } catch (err) {
            this.options.onListenerError?.(err, next);
          }
        }
      }
    } finally {
      this.delivering = false;
    }
  }

  private persist(event: AioEvent): void {
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
      this.saveCounts(db);
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
   *
   * With a `filter`, the plan describes the filtered stream: its own
   * `streamId`, and events numbered by their position in it. The caller
   * numbers later live events by counting on from `hello.lastSeq`.
   */
  replay(hello: ClientHello, filter: EventFilter = null): ReplayPlan {
    if (filter !== null) return this.replayFiltered(hello, filter);
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

  private replayFiltered(hello: ClientHello, filter: ReadonlySet<EventType>): ReplayPlan {
    const streamId = this.filteredStreamId(filter);
    const lastSeq = this.filteredLastSeq(filter);
    const none: ReplayPlan = {
      hello: { type: "hello", streamId, lastSeq, replaying: false },
      events: [],
    };
    if (hello.streamId !== streamId || hello.lastSeq === null) return none;
    const from = hello.lastSeq;
    if (from > lastSeq) return none;
    const missed = this.lastMatching(filter, lastSeq - from);
    if (missed === null) return none;
    return {
      hello: { ...none.hello, replaying: true },
      events: missed.map((e, i) => ({ ...e, streamId, seq: from + 1 + i })),
    };
  }

  /**
   * The newest `count` events whose type is in `filter`, oldest first, or
   * `null` when fewer are kept. The buffer and SQLite each keep an unbroken
   * run of the newest events, so the newest `count` matches in either one
   * are the newest in the stream.
   */
  private lastMatching(filter: ReadonlySet<EventType>, count: number): AioEvent[] | null {
    if (count === 0) return [];
    const found: AioEvent[] = [];
    for (let i = this.buffer.length - 1; i >= 0 && found.length < count; i -= 1) {
      const event = this.buffer[i]!;
      if (filter.has(event.type)) found.push(event);
    }
    if (found.length === count) return found.reverse();
    const db = this.options.db;
    if (!db) return null;
    const types = [...filter];
    const rows = db
      .prepare(
        `SELECT json FROM svc_events WHERE type IN (${types.map(() => "?").join(", ")}) ` +
          "ORDER BY seq DESC LIMIT ?",
      )
      .all(...types, count) as { json: string }[];
    if (rows.length !== count) return null;
    return rows.reverse().map((r) => parseStoredEvent(r.json));
  }

  /** Every kept event after `seq`, or `null` when some of them are gone. */
  private eventsAfter(seq: number): AioEvent[] | null {
    const first = this.buffer[0];
    if (first && first.seq <= seq + 1) return this.buffer.filter((e) => e.seq > seq);
    const db = this.options.db;
    if (!db) return null;
    const rows = db
      .prepare("SELECT seq, json FROM svc_events WHERE seq > ? ORDER BY seq")
      .all(seq) as { seq: number; json: string }[];
    if (rows.length === 0 || rows[0]?.seq !== seq + 1) return null;
    return rows.map((r) => parseStoredEvent(r.json));
  }
}
