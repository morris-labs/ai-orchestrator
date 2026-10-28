// The event sink that the core modules publish into. W2 stamps each payload
// with the stream fields (`id`, `time`, `source`, `streamId`, `seq`,
// `sourceSeq`) and relays it on `events.stream`.
import { EventEmitter } from "node:events";
import type { EventOf } from "@agentbox/contracts";

/** The stream fields W2 adds when it relays an event. */
export type StreamFields = "id" | "time" | "source" | "streamId" | "seq" | "sourceSeq";

/** The event types the core emits. */
export type CoreEventType =
  "box.changed" | "container.changed" | "container.stats" | "settings.changed";

/** A core event without its stream fields. */
export type CoreEventPayload = {
  [T in CoreEventType]: Omit<EventOf<T>, StreamFields>;
}[CoreEventType];

/**
 * An `EventEmitter` that carries core events. Each payload is emitted twice:
 * as `"event"` for listeners that relay everything, and under its own `type`.
 */
export class CoreEvents extends EventEmitter {
  publish(payload: CoreEventPayload): void {
    this.emit("event", payload);
    this.emit(payload.type, payload);
  }

  /** Subscribes to every core event and returns the unsubscribe function. */
  subscribe(listener: (payload: CoreEventPayload) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}
