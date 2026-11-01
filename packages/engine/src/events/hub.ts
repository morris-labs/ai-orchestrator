// The engine's event stream: numbers events, keeps a replay buffer, and
// fans them out to subscribers. See the sequence rules in the contracts'
// `events.ts`.
import { randomUUID } from "node:crypto";
import { EventSchema, type AioEvent } from "@aio/contracts";
import type { EventDraft, EventSink } from "../api/core-interface.js";

export interface EventHubOptions {
  /** `engine:<container>`. */
  source: string;
  /** How many events the replay buffer keeps. */
  capacity?: number;
  streamId?: string;
  now?: () => Date;
  newId?: () => string;
}

export type EventListener = (event: AioEvent) => void;

/** The outcome of a client's `hello`: what to send back and what to replay. */
export interface ReplayPlan {
  replaying: boolean;
  events: AioEvent[];
}

export class EventHub implements EventSink {
  readonly streamId: string;
  readonly source: string;
  private seq = 0;
  private readonly buffer: AioEvent[] = [];
  private readonly capacity: number;
  private readonly listeners = new Set<EventListener>();
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(options: EventHubOptions) {
    this.source = options.source;
    this.streamId = options.streamId ?? randomUUID();
    this.capacity = options.capacity ?? 5000;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /** The `seq` of the newest event; 0 when there is none. */
  get lastSeq(): number {
    return this.seq;
  }

  /**
   * Validates the draft against the event schema, numbers it, stores it, and
   * hands it to every listener. Throws a `ZodError` for an invalid draft, in
   * which case no number is used.
   */
  emit(draft: EventDraft): AioEvent {
    const seq = this.seq + 1;
    const event = EventSchema.parse({
      ...draft,
      id: this.newId(),
      time: this.now().toISOString(),
      source: this.source,
      streamId: this.streamId,
      seq,
      sourceSeq: seq,
    });
    this.seq = seq;
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    for (const listener of this.listeners) listener(event);
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Decides what a client that last saw `lastSeq` in `streamId` gets. It
   * replays only when the stream matches and the buffer still holds every
   * later event; otherwise the client must reload through REST.
   */
  planReplay(streamId: string | null, lastSeq: number | null): ReplayPlan {
    if (streamId !== this.streamId || lastSeq === null || lastSeq > this.seq) {
      return { replaying: false, events: [] };
    }
    const oldest = this.buffer[0]?.seq ?? this.seq + 1;
    if (lastSeq + 1 < oldest) return { replaying: false, events: [] };
    return { replaying: true, events: this.buffer.filter((e) => e.seq > lastSeq) };
  }
}
