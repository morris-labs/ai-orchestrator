// The client side of `events.stream`: hello, replay, resync, and reconnect.
//
// The protocol, from `@agentbox/contracts` `events.ts`: the client sends a
// `hello` with the last `streamId` and `seq` it saw; the server answers with
// its own `hello`. When `replaying` is true, the missed events follow. When
// it is false, the client must reload its state through REST before it uses
// later events, so the connection calls `onResync`. A gap in `seq` also
// triggers a fresh `hello`.
import {
  ServerStreamFrameSchema,
  type AgentBoxEvent,
  type ClientHello,
  type EventType,
} from "@agentbox/contracts";
import type { ApiClient } from "../api/client";

export type StreamStatus = "connecting" | "open" | "closed";

export interface EventsConnectionOptions {
  client: ApiClient;
  /** Event types to receive; absent means all. */
  types?: readonly EventType[];
  onEvent: (event: AgentBoxEvent) => void;
  /** Called after the server says it can't replay: reload state through REST. */
  onResync: () => void;
  onStatus?: (status: StreamStatus) => void;
  /** Called with frames that don't match the contract. */
  onInvalidFrame?: (raw: unknown, error: string) => void;
  /** First reconnect delay in milliseconds; doubles up to `maxDelayMs`. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Computes the next reconnect delay: doubles from `initial`, capped at `max`. */
export function nextDelay(attempt: number, initial: number, max: number): number {
  return Math.min(max, initial * 2 ** Math.max(0, attempt));
}

/** A self-reconnecting subscription to the server's event stream. */
export class EventsConnection {
  private socket: WebSocket | null = null;
  private streamId: string | null = null;
  private lastSeq: number | null = null;
  private attempt = 0;
  private timer: unknown = null;
  private stopped = false;
  /** True between a `hello` the client sent and the server's answer; events are dropped meanwhile. */
  private awaitingHello = false;
  private status: StreamStatus = "closed";
  private readonly opts: Required<
    Pick<EventsConnectionOptions, "initialDelayMs" | "maxDelayMs" | "setTimer" | "clearTimer">
  > &
    EventsConnectionOptions;

  constructor(options: EventsConnectionOptions) {
    this.opts = {
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      ...options,
    };
  }

  /** The position the next `hello` asks to resume from. */
  get position(): { streamId: string | null; lastSeq: number | null } {
    return { streamId: this.streamId, lastSeq: this.lastSeq };
  }

  get currentStatus(): StreamStatus {
    return this.status;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.opts.clearTimer(this.timer);
    this.timer = null;
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onclose = null;
      s.close();
    }
    this.setStatus("closed");
  }

  /** Asks the server to replay from the current position, or to resync. */
  resync(): void {
    this.sendHello();
  }

  private setStatus(status: StreamStatus) {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }

  private connect() {
    if (this.stopped) return;
    this.setStatus("connecting");
    const query: Record<string, unknown> = {};
    if (this.opts.types && this.opts.types.length > 0) query.types = this.opts.types.join(",");
    let socket: WebSocket;
    try {
      socket = this.opts.client.openSocket("events.stream", { query });
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.sendHello();
    };
    socket.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch {
        this.opts.onInvalidFrame?.(ev.data, "not JSON");
        return;
      }
      this.handleFrame(raw);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      // `onclose` follows and schedules the reconnect.
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.setStatus("closed");
    const delay = nextDelay(this.attempt, this.opts.initialDelayMs, this.opts.maxDelayMs);
    this.attempt += 1;
    this.timer = this.opts.setTimer(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private sendHello() {
    this.awaitingHello = true;
    const hello: ClientHello = {
      type: "hello",
      streamId: this.streamId,
      lastSeq: this.streamId === null ? null : this.lastSeq,
    };
    this.socket?.send(JSON.stringify(hello));
  }

  /** Handles one parsed JSON frame. Public for tests. */
  handleFrame(raw: unknown): void {
    const parsed = ServerStreamFrameSchema.safeParse(raw);
    if (!parsed.success) {
      this.opts.onInvalidFrame?.(raw, parsed.error.issues[0]?.message ?? "invalid frame");
      return;
    }
    const frame = parsed.data;
    if (frame.type === "hello") {
      this.awaitingHello = false;
      this.setStatus("open");
      const matched = frame.replaying && frame.streamId === this.streamId;
      if (!matched) {
        this.streamId = frame.streamId;
        this.lastSeq = frame.lastSeq;
        this.opts.onResync();
      }
      return;
    }
    if (this.awaitingHello) return;
    if (frame.streamId !== this.streamId) {
      // An event from a stream the client hasn't said hello to.
      this.streamId = null;
      this.lastSeq = null;
      this.sendHello();
      return;
    }
    if (this.lastSeq !== null && frame.seq <= this.lastSeq) return;
    if (this.lastSeq !== null && frame.seq !== this.lastSeq + 1) {
      // A gap: ask the server to replay from what the client has.
      this.sendHello();
      return;
    }
    this.lastSeq = frame.seq;
    this.opts.onEvent(frame);
  }
}
