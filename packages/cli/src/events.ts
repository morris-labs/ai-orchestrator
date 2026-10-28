// `agentbox events`: tails the server's event stream as JSON lines.
import { ServerStreamFrameSchema, serverRoutes } from "@agentbox/contracts";
import WebSocket from "ws";

export type WebSocketCtor = typeof WebSocket;

export interface TailOptions {
  baseUrl: string;
  token: string;
  types?: string;
  /** Stop after this many events (not counting `hello`). */
  count?: number;
  write: (line: string) => void;
  WebSocket?: WebSocketCtor;
  signal?: AbortSignal;
}

/** Builds the `events.stream` WebSocket URL. */
export function eventsUrl(baseUrl: string, token: string, types?: string): string {
  const url = new URL(serverRoutes["events.stream"].path, baseUrl.replace(/\/$/, "") + "/");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  if (types) url.searchParams.set("types", types);
  return url.toString();
}

/**
 * Connects, sends a first `hello`, and writes every frame as one JSON line.
 * Resolves when the socket closes, `count` events arrive, or `signal` aborts.
 * Rejects when the connection fails or a frame breaks the contract.
 */
export function tailEvents(options: TailOptions): Promise<void> {
  const Ctor = options.WebSocket ?? WebSocket;
  return new Promise<void>((resolve, reject) => {
    const socket = new Ctor(eventsUrl(options.baseUrl, options.token, options.types));
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
      const parsed = ServerStreamFrameSchema.safeParse(JSON.parse(data.toString()));
      if (!parsed.success) {
        finish(new Error("The server sent an event that doesn't match the contract."));
        return;
      }
      options.write(`${JSON.stringify(parsed.data)}\n`);
      if (parsed.data.type !== "hello") seen += 1;
      if (options.count !== undefined && seen >= options.count) finish();
    });
    socket.on("unexpected-response", (_req, res) => {
      finish(
        new Error(
          res.statusCode === 401
            ? "The server refused the token. Check ~/.claude-box/server.token or AGENTBOX_TOKEN."
            : `The server refused the event stream with status ${res.statusCode}.`,
        ),
      );
    });
    socket.on("error", (err) => finish(err));
    socket.on("close", () => finish());
  });
}
