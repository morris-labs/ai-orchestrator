// `aio box attach MACHINE/BOX`: attaches this terminal to a box on another
// machine over the server's `terminals.open` WebSocket, which the server
// relays through the hub. Keys go out as binary frames and the box's output
// comes back the same way; a resize of this terminal goes out as a `resize`
// control frame.
import {
  ApiErrorSchema,
  TerminalServerMessageSchema,
  machinePath,
  serverRoutes,
  type Platform,
} from "@aio/contracts";
import { asIdentityError } from "@aio/contracts/tls";
import WebSocket from "ws";
import { ApiCallError } from "./client.js";
import type { WebSocketCtor } from "./events.js";

/** The byte of Ctrl+]. Pressed twice in a row, it detaches, as `docker exec` does locally. */
export const DETACH_KEY = 0x1d;

/** The terminal the CLI runs in: its keys, its screen, and its size. */
export interface TerminalIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(raw: boolean): unknown };
  output: {
    write(data: Uint8Array | string): unknown;
    columns?: number;
    rows?: number;
    on?(event: "resize", cb: () => void): unknown;
    off?(event: "resize", cb: () => void): unknown;
  };
}

export interface RemoteAttachOptions {
  baseUrl: string;
  token: string;
  /** The machine that runs the box. */
  machineId: string;
  boxId: string;
  kind: "session" | "side" | "shell";
  platform?: Platform;
  io: TerminalIo;
  /** Receives notes for the person, such as how to detach. */
  note: (text: string) => void;
  WebSocket?: WebSocketCtor;
  /** TLS options for the connection, such as `pinnedTlsOptions()` for a pinned server. */
  tls?: object;
}

/** Builds the `terminals.open` URL for `machineId`. The token never goes in it. */
export function terminalUrl(
  baseUrl: string,
  machineId: string,
  query: Record<string, string | number>,
): string {
  const url = new URL(
    baseUrl.replace(/\/$/, "") + machinePath(serverRoutes["terminals.open"].path, machineId),
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
  return url.toString();
}

/**
 * Finds the detach sequence, Ctrl+] twice in a row, in a chunk of keys.
 * `pending` is true when the chunk before ended with one Ctrl+].
 * Returns the bytes to send before the detach, or all of them without one,
 * and whether this chunk ends with one Ctrl+] held back.
 */
export function scanDetach(
  chunk: Buffer,
  pending: boolean,
): { send: Buffer; detach: boolean; pending: boolean } {
  const out: number[] = [];
  let held = pending;
  for (const byte of chunk) {
    if (byte === DETACH_KEY) {
      if (held) return { send: Buffer.from(out), detach: true, pending: false };
      held = true;
      continue;
    }
    if (held) out.push(DETACH_KEY);
    held = false;
    out.push(byte);
  }
  return { send: Buffer.from(out), detach: false, pending: held };
}

/** The error for a refused upgrade, from the server's JSON error body when it sent one. */
function upgradeError(status: number, body: string): ApiCallError {
  try {
    const parsed = ApiErrorSchema.safeParse(JSON.parse(body));
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      return new ApiCallError(status, code, message, details);
    }
  } catch {
    // Not JSON; fall through.
  }
  return new ApiCallError(
    status,
    "unknown",
    `The server refused the terminal with HTTP ${status}.`,
  );
}

/**
 * Attaches `io` to the box's terminal until the box's process exits, the
 * connection closes, or the person detaches. Resolves with the exit code:
 * the process's own, or 0 after a detach. Rejects when the server refuses
 * the terminal or the connection drops.
 */
export function attachRemote(options: RemoteAttachOptions): Promise<number> {
  const { io } = options;
  const Ctor = options.WebSocket ?? WebSocket;
  const size = () => ({ cols: io.output.columns ?? 80, rows: io.output.rows ?? 24 });
  const query: Record<string, string | number> = {
    kind: options.kind,
    boxId: options.boxId,
    ...size(),
  };
  if (options.platform) query.platform = options.platform;

  return new Promise<number>((resolve, reject) => {
    const socket = new Ctor(terminalUrl(options.baseUrl, options.machineId, query), {
      ...options.tls,
      headers: { authorization: `Bearer ${options.token}` },
    });
    let exitCode: number | null = null;
    let detached = false;
    let serverError: ApiCallError | null = null;
    let raw = false;
    let pending = false;
    let settled = false;

    const onKeys = (data: Buffer | string) => {
      const chunk = typeof data === "string" ? Buffer.from(data) : data;
      const scan = scanDetach(chunk, pending);
      pending = scan.pending;
      if (scan.send.length > 0 && socket.readyState === socket.OPEN) {
        socket.send(scan.send, { binary: true });
      }
      if (scan.detach) {
        detached = true;
        socket.close(1000, "detached");
      }
    };
    const onResize = () => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", ...size() }));
      }
    };
    const cleanup = () => {
      io.input.off("data", onKeys);
      io.output.off?.("resize", onResize);
      if (raw) io.input.setRawMode?.(false);
      io.input.pause();
    };
    const finish = (err: Error | null, code = 0) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(code);
    };

    socket.on("unexpected-response", (req, res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => {
        req.destroy();
        finish(upgradeError(res.statusCode ?? 0, body));
      });
    });
    socket.on("error", (err) =>
      finish(asIdentityError(err, new URL(options.baseUrl).host) as Error),
    );
    socket.on("open", () => {
      if (io.input.isTTY && io.input.setRawMode) {
        io.input.setRawMode(true);
        raw = true;
      }
      io.input.on("data", onKeys);
      io.input.resume();
      io.output.on?.("resize", onResize);
      options.note("Attached. To detach, press Ctrl+] twice.\r\n");
    });
    socket.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (isBinary) {
        io.output.write(bytes);
        return;
      }
      let json: unknown;
      try {
        json = JSON.parse(bytes.toString());
      } catch {
        return;
      }
      const parsed = TerminalServerMessageSchema.safeParse(json);
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.type === "exit") exitCode = msg.exitCode;
      else if (msg.type === "error") {
        serverError = new ApiCallError(0, msg.error.code, msg.error.message, msg.error.details);
      }
    });
    socket.on("close", (code, reason) => {
      if (serverError) return finish(serverError);
      if (detached) {
        options.note("\r\nDetached. The box keeps running.\n");
        return finish(null, 0);
      }
      if (exitCode !== null || code === 1000) return finish(null, exitCode ?? 0);
      const why = reason.toString() || `close code ${code}`;
      finish(new Error(`The terminal connection closed: ${why}`));
    });
  });
}
