// One `engine.events` WebSocket: the hello exchange, replay and resync, live
// events filtered by type, and the lease frames in both directions.
import {
  EngineStreamClientFrameSchema,
  type AgentBoxEvent,
  type EngineStreamFrame,
} from "@agentbox/contracts";
import type { WebSocket } from "ws";
import type { Logger } from "../api/core-interface.js";
import type { EventHub } from "./hub.js";
import type { EngineLeaseBroker } from "./leases.js";

export interface EventSocketOptions {
  hub: EventHub;
  leases: EngineLeaseBroker;
  log: Logger;
  /** Event types to forward; `null` forwards every type. Control frames always pass. */
  types: Set<string> | null;
  /** Close a socket whose send buffer grows past this many bytes. */
  maxBufferedBytes?: number;
}

/** Parses the `types` query value: comma-separated event types, or absent for all. */
export function parseTypesFilter(types: string | undefined): Set<string> | null {
  if (types === undefined) return null;
  const set = new Set(
    types
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== ""),
  );
  return set.size === 0 ? null : set;
}

/** Serves the engine event protocol on an open socket until it closes. */
export function serveEventSocket(socket: WebSocket, options: EventSocketOptions): void {
  const { hub, leases, log, types } = options;
  const maxBuffered = options.maxBufferedBytes ?? 8 * 1024 * 1024;
  let subscribed = false;
  let unsubscribe = () => {};
  let detachLeases = () => {};

  const send = (frame: EngineStreamFrame) => {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > maxBuffered) {
      log.warn("Closed an event socket that stopped reading");
      socket.close(1013, "The client is too slow.");
      return;
    }
    socket.send(JSON.stringify(frame));
  };
  const wanted = (event: AgentBoxEvent) => types === null || types.has(event.type);

  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      log.warn("Ignored a binary frame on the event socket");
      return;
    }
    let frame;
    try {
      frame = EngineStreamClientFrameSchema.parse(JSON.parse(data.toString()));
    } catch {
      log.warn("Ignored an event socket frame that doesn't match the contract");
      return;
    }
    if (frame.type === "lease.response") {
      leases.handleResponse(frame.response);
      return;
    }
    // A hello: the first one subscribes, a later one resyncs.
    const plan = hub.planReplay(frame.streamId, frame.lastSeq);
    send({
      type: "hello",
      streamId: hub.streamId,
      lastSeq: hub.lastSeq,
      replaying: plan.replaying,
    });
    for (const event of plan.events) if (wanted(event)) send(event);
    if (!subscribed) {
      subscribed = true;
      unsubscribe = hub.subscribe((event) => {
        if (wanted(event)) send(event);
      });
      detachLeases = leases.attach({ send });
    }
  });

  socket.on("close", () => {
    unsubscribe();
    detachLeases();
  });
  socket.on("error", (err) => log.debug("Event socket error", { error: String(err) }));
}
