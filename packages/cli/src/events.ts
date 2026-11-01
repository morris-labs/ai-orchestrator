// `aio events`: tails the server's event stream as JSON lines.
import { ServerStreamFrameSchema, serverRoutes } from "@aio/contracts";
import { asIdentityError } from "@aio/contracts/tls";
import WebSocket from "ws";
import { jsonText } from "./format.js";

export type WebSocketCtor = typeof WebSocket;

export interface TailOptions {
  baseUrl: string;
  token: string;
  types?: string;
  /** Stop after this many events (not counting `hello`). */
  count?: number;
  write: (line: string) => void;
  /** Receives warnings, such as a skipped frame that doesn't match the contract. */
  warn?: (line: string) => void;
  WebSocket?: WebSocketCtor;
  /** TLS options for the connection, such as `pinnedTlsOptions()` for a pinned server. */
  tls?: object;
  signal?: AbortSignal;
}

/** Close codes that end a stream without an error: normal, going away, and no status. */
const NORMAL_CLOSE_CODES = new Set([1000, 1001, 1005]);

/** Builds the `events.stream` WebSocket URL. The token never goes in it. */
export function eventsUrl(baseUrl: string, types?: string): string {
  // Appended, not resolved, so a path prefix in `baseUrl` stays, as it does
  // for the REST calls.
  const url = new URL(baseUrl.replace(/\/$/, "") + serverRoutes["events.stream"].path);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (types) url.searchParams.set("types", types);
  return url.toString();
}

/**
 * Connects, sends a first `hello`, and writes every frame as one JSON line.
 * Resolves when the server closes the socket normally, `count` events
 * arrive, or `signal` aborts. A frame with a `type` that fails the contract
 * is printed as received, with a warning. Rejects when the connection fails,
 * a frame isn't JSON or has no `type`, or the server closes the socket with
 * an error code, as it does for an unknown event type.
 */
export function tailEvents(options: TailOptions): Promise<void> {
  const Ctor = options.WebSocket ?? WebSocket;
  return new Promise<void>((resolve, reject) => {
    // The token goes in the upgrade's `Authorization` header, out of the URL.
    const socket = new Ctor(eventsUrl(options.baseUrl, options.types), {
      ...options.tls,
      headers: { authorization: `Bearer ${options.token}` },
    });
    let seen = 0;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING)
        socket.close();
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => finish();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    socket.on("open", () =>
      socket.send(JSON.stringify({ type: "hello", streamId: null, lastSeq: null })),
    );
    socket.on("message", (data) => {
      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        finish(new Error("The server sent an event that isn't JSON."));
        return;
      }
      const parsed = ServerStreamFrameSchema.safeParse(json);
      let frame: unknown;
      let type: unknown;
      if (parsed.success) {
        frame = parsed.data;
        type = parsed.data.type;
      } else {
        // A server of another version can send an event type, or a settings
        // key, this build doesn't know. Print such a frame as it came and keep
        // going; a frame with no type at all is broken.
        type = (json as { type?: unknown } | null)?.type;
        if (typeof type !== "string") {
          finish(new Error("The server sent an event that doesn't match the contract."));
          return;
        }
        frame = json;
        options.warn?.(
          `Warning: a ${jsonText(type)} event doesn't match this CLI's contract; printed as received.\n`,
        );
      }
      options.write(`${jsonText(frame)}\n`);
      if (type !== "hello") seen += 1;
      if (options.count !== undefined && seen >= options.count) finish();
    });
    socket.on("unexpected-response", (_req, res) => {
      finish(
        new Error(
          res.statusCode === 401
            ? "The server refused the token. Check server.token in the data directory (~/.ai-orchestrator or AIO_DATA_DIR), or AIO_TOKEN."
            : `The server refused the event stream with status ${res.statusCode}.`,
        ),
      );
    });
    socket.on("error", (err) =>
      finish(asIdentityError(err, new URL(options.baseUrl).host) as Error),
    );
    socket.on("close", (code: number, reason: Buffer) => {
      if (NORMAL_CLOSE_CODES.has(code)) return finish();
      const why = reason.toString() || "no reason given";
      finish(new Error(`The server closed the event stream: ${why} (code ${code}).`));
    });
  });
}
