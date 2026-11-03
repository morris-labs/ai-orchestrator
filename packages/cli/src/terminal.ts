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
import { ApiCallError, InterruptedError } from "./client.js";
import type { WebSocketCtor } from "./events.js";

/** The byte of Ctrl+]. Pressed twice in a row, it detaches, as `docker exec` does locally. */
export const DETACH_KEY = 0x1d;

/** How often the CLI pings the server. Two silent intervals in a row end the attach. */
const PING_MS = 15_000;
/** How long the opening handshake can stall. It outlasts the hub's wait for a machine. */
const HANDSHAKE_MS = 45_000;
/** How long a detach waits for the server to answer the close. */
const DETACH_CLOSE_MS = 2_000;

/**
 * Turns off the modes tmux sets on the terminal it attaches to, then leaves
 * the alternate screen: mouse tracking, focus events, bracketed paste, cursor
 * and keypad application modes, extended keys, the scroll region, text
 * attributes, cursor visibility and style, and autowrap.
 */
export const TERMINAL_RESTORE =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l" +
  "\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b>\x1b[>4m\x1b[r\x1b[0m" +
  "\x1b[?25h\x1b[0 q\x1b[?7h\x1b[?1049l";

/** The terminal the CLI runs in: its keys, its screen, and its size. */
export interface TerminalIo {
  input: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(raw: boolean): unknown };
  output: {
    isTTY?: boolean;
    write(data: Uint8Array | string): unknown;
    columns?: number;
    rows?: number;
    on?(event: "resize", cb: () => void): unknown;
    off?(event: "resize", cb: () => void): unknown;
  };
}

/**
 * Reads one line of secret text from `input`, such as an enrollment code. On
 * a terminal, raw mode keeps the text off the screen, and Ctrl+C throws
 * `InterruptedError`. End of input ends the line.
 */
export function readSecretLine(input: TerminalIo["input"], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new InterruptedError());
    const raw = Boolean(input.isTTY && input.setRawMode);
    let text = "";
    const finish = (settle: () => void) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (raw) input.setRawMode?.(false);
      // A stream that stays in flowing mode keeps the process alive.
      input.pause();
      settle();
    };
    const onEnd = () => finish(() => resolve(text));
    const onError = (err: Error) => finish(() => reject(err));
    const onAbort = () => finish(() => reject(new InterruptedError()));
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString()) {
        if (ch === "\n" || ch === "\r") return onEnd();
        if (raw && ch === "\x03") return onAbort();
        if (raw && ch === "\x04") return onEnd();
        if (raw && (ch === "\x7f" || ch === "\b")) text = text.slice(0, -1);
        else text += ch;
      }
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (raw) input.setRawMode?.(true);
    input.resume();
  });
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
  /** Overrides the ping interval, in milliseconds. */
  pingMs?: number;
  /** Overrides the opening handshake timeout, in milliseconds. */
  handshakeMs?: number;
  /** Overrides how long a detach waits for the server, in milliseconds. */
  detachCloseMs?: number;
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
 * the terminal, the connection drops, or the server stops answering pings.
 */
export function attachRemote(options: RemoteAttachOptions): Promise<number> {
  const { io } = options;
  const Ctor = options.WebSocket ?? WebSocket;
  // A pty without a window size reports 0, which the server refuses.
  const size = () => ({ cols: io.output.columns || 80, rows: io.output.rows || 24 });
  const query: Record<string, string | number> = {
    kind: options.kind,
    boxId: options.boxId,
    ...size(),
  };
  if (options.platform) query.platform = options.platform;

  return new Promise<number>((resolve, reject) => {
    const socket = new Ctor(terminalUrl(options.baseUrl, options.machineId, query), {
      handshakeTimeout: options.handshakeMs ?? HANDSHAKE_MS,
      ...options.tls,
      headers: { authorization: `Bearer ${options.token}` },
    });
    let exitCode: number | null = null;
    let exited = false;
    let ready = false;
    let sawOutput = false;
    let detached = false;
    let awaitingPong = false;
    let unanswered = false;
    let pingTimer: NodeJS.Timeout | undefined;
    let detachTimer: NodeJS.Timeout | undefined;
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
        detachTimer = setTimeout(
          () => socket.terminate(),
          options.detachCloseMs ?? DETACH_CLOSE_MS,
        );
      }
    };
    const onResize = () => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", ...size() }));
      }
    };
    const cleanup = () => {
      clearInterval(pingTimer);
      clearTimeout(detachTimer);
      // Without an exit frame, tmux never got to send its own restore sequences.
      if (sawOutput && !exited && io.output.isTTY) io.output.write(TERMINAL_RESTORE);
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
      pingTimer = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return;
        if (awaitingPong) {
          unanswered = true;
          socket.terminate();
          return;
        }
        awaitingPong = true;
        socket.ping();
      }, options.pingMs ?? PING_MS);
    });
    socket.on("pong", () => {
      awaitingPong = false;
    });
    socket.on("message", (data, isBinary) => {
      // A pong can queue behind a burst of output on a slow link.
      awaitingPong = false;
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (isBinary) {
        sawOutput = true;
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
      if (msg.type === "ready") ready = true;
      else if (msg.type === "exit") {
        exited = true;
        exitCode = msg.exitCode;
      } else if (ready) {
        // The terminal keeps running after an error about one frame.
        options.note(`\r\nThe server refused a terminal frame: ${msg.error.message}\r\n`);
      } else {
        serverError = new ApiCallError(0, msg.error.code, msg.error.message, msg.error.details);
      }
    });
    socket.on("close", (code, reason) => {
      if (serverError) return finish(serverError);
      if (detached) {
        // The note follows the restore so that it lands on the main screen.
        finish(null, 0);
        options.note("\r\nDetached. The box keeps running.\n");
        return;
      }
      // An exit frame with a null code means a signal ended the process.
      if (exited) return finish(null, exitCode ?? 1);
      if (code === 1000) return finish(null, 0);
      const why = unanswered
        ? "the server stopped answering pings"
        : reason.toString() || `close code ${code}`;
      finish(new Error(`The terminal connection closed: ${why}`));
    });
  });
}
