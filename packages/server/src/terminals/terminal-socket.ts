// Serves one `terminals.open` WebSocket: binary frames carry terminal bytes
// both ways, and JSON text frames carry `resize`, `input`, `ready`, `exit`,
// and `error`.
import { randomUUID } from "node:crypto";
import {
  TerminalClientMessageSchema,
  TerminalServerMessageSchema,
  type TerminalServerMessage,
} from "@agentbox/contracts";
import WebSocket from "ws";
import { toApiFailure } from "../api/errors.js";
import type { ExecBackend, ExecRequest } from "./exec.js";

export interface TerminalEnd {
  terminalId: string;
  exitCode: number | null;
  /** True when the client closed the socket first. */
  closedByClient: boolean;
}

export function sendControl(ws: WebSocket, message: TerminalServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(TerminalServerMessageSchema.parse(message)));
  }
}

/** Starts the exec and wires it to the socket. Resolves when the terminal ends. */
export async function serveTerminal(
  ws: WebSocket,
  backend: ExecBackend,
  request: ExecRequest,
): Promise<TerminalEnd> {
  const terminalId = randomUUID();
  let closedByClient = false;
  // Buffer the client's frames until the exec is up.
  const pending: [WebSocket.RawData, boolean][] = [];
  const early = (data: WebSocket.RawData, isBinary: boolean) => pending.push([data, isBinary]);
  const earlyClose = () => (closedByClient = true);
  ws.on("message", early);
  ws.on("close", earlyClose);

  let session;
  try {
    session = await backend.start(request);
  } catch (err) {
    sendControl(ws, { type: "error", error: toApiFailure(err).toBody().error });
    ws.close(1011, "exec failed");
    return { terminalId, exitCode: null, closedByClient };
  } finally {
    ws.off("message", early);
    ws.off("close", earlyClose);
  }

  // Errors also end the stream; the listeners below handle the ending.
  session.stream.on("error", () => undefined);
  if (closedByClient || ws.readyState !== WebSocket.OPEN) {
    session.close();
    return { terminalId, exitCode: null, closedByClient: true };
  }

  const { stream } = session;
  const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
    if (isBinary) {
      stream.write(buf);
      return;
    }
    let parsed;
    try {
      parsed = TerminalClientMessageSchema.parse(JSON.parse(buf.toString()));
    } catch {
      sendControl(ws, {
        type: "error",
        error: { code: "validation", message: "The frame is not a terminal control message." },
      });
      return;
    }
    if (parsed.type === "resize")
      void session.resize(parsed.cols, parsed.rows).catch(() => undefined);
    else stream.write(parsed.data);
  };
  ws.on("message", onMessage);
  sendControl(ws, { type: "ready", terminalId });
  for (const [data, isBinary] of pending) onMessage(data, isBinary);
  stream.on("data", (chunk: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
  });

  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      ws.off("message", onMessage);
      const exitCode = closedByClient ? null : await session.exitCode();
      sendControl(ws, { type: "exit", exitCode });
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, "ended");
      resolve({ terminalId, exitCode, closedByClient });
    };
    stream.on("end", () => void finish());
    stream.on("close", () => void finish());
    stream.on("error", () => void finish());
    ws.on("close", () => {
      if (done) return;
      closedByClient = true;
      session.close();
      void finish();
    });
  });
}
