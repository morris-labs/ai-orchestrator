// An event sink the core can hold before the hub exists: the hub needs the
// core's database, and the core needs a sink when it is built. Events emitted
// before `attach()` wait in order and go out when the hub arrives.
import type { AioEvent } from "@aio/contracts";
import type { EventInput, EventSink } from "../api/core-interface.js";

export class LateSink implements EventSink {
  private target: EventSink | null = null;
  private readonly pending: EventInput[] = [];

  attach(target: EventSink): void {
    this.target = target;
    for (const event of this.pending.splice(0)) target.emit(event);
  }

  emit(event: EventInput): AioEvent {
    if (this.target) return this.target.emit(event);
    this.pending.push(event);
    // Before the hub exists the event has no number yet; callers that need
    // the numbered event only run after startup.
    return {
      ...event,
      id: "pending",
      time: new Date().toISOString(),
      source: "server",
      streamId: "pending",
      seq: 1,
      sourceSeq: 1,
    } as AioEvent;
  }
}
