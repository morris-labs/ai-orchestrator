// The client side of a terminal or job stream (`terminals.open`,
// `jobs.stream`): terminal bytes as binary frames both ways, control
// messages as JSON text frames.
import {
  TerminalServerMessageSchema,
  type ApiError,
  type TerminalClientMessage,
} from "@agentbox/contracts";
import type { ApiClient } from "../api/client";

/** What a terminal pane connects to. */
export type TerminalTarget =
  | { kind: "session"; boxId: string }
  | { kind: "side"; boxId: string; platform: "claude" | "codex" | "copilot" }
  | { kind: "shell"; boxId: string }
  | { kind: "shell"; projectId: string }
  | { kind: "job"; jobId: string };

export interface TerminalHandlers {
  onData: (data: Uint8Array) => void;
  onReady?: (terminalId: string) => void;
  /** The attached process ended; `exitCode` is `null` when unknown. */
  onExit: (exitCode: number | null) => void;
  onError?: (error: ApiError["error"]) => void;
}

/** Builds the WebSocket for a target with the starting size. */
export function openTerminalSocket(
  client: ApiClient,
  target: TerminalTarget,
  size: { cols: number; rows: number },
): WebSocket {
  if (target.kind === "job") {
    return client.openSocket("jobs.stream", { params: { jobId: target.jobId } });
  }
  const query: Record<string, unknown> = { kind: target.kind, cols: size.cols, rows: size.rows };
  if ("boxId" in target) query.boxId = target.boxId;
  if ("projectId" in target) query.projectId = target.projectId;
  if (target.kind === "side") query.platform = target.platform;
  return client.openSocket("terminals.open", { query });
}

/** One live terminal stream. It doesn't reconnect: a closed stream is an ended session. */
export class TerminalConnection {
  private readonly socket: WebSocket;
  private readonly encoder = new TextEncoder();
  private ended = false;

  constructor(
    socket: WebSocket,
    private readonly handlers: TerminalHandlers,
  ) {
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onmessage = (ev: MessageEvent) => this.handleMessage(ev.data);
    socket.onclose = () => this.end(null);
  }

  /** Handles one incoming frame. Public for tests. */
  handleMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      this.handlers.onData(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      this.handlers.onData(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return;
    }
    if (typeof data !== "string") return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = TerminalServerMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg = parsed.data;
    if (msg.type === "ready") this.handlers.onReady?.(msg.terminalId);
    else if (msg.type === "exit") this.end(msg.exitCode);
    else this.handlers.onError?.(msg.error);
  }

  private end(code: number | null) {
    if (this.ended) return;
    this.ended = true;
    this.handlers.onExit(code);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  private sendControl(msg: TerminalClientMessage) {
    if (this.socket.readyState === 1) this.socket.send(JSON.stringify(msg));
  }

  /** Sends keyboard input as a binary frame. */
  write(text: string): void {
    if (this.ended || this.socket.readyState !== 1) return;
    this.socket.send(this.encoder.encode(text));
  }

  resize(cols: number, rows: number): void {
    if (this.ended) return;
    this.sendControl({ type: "resize", cols, rows });
  }

  close(): void {
    this.socket.onclose = null;
    this.ended = true;
    this.socket.close();
  }
}
