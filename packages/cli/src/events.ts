// `agentbox events`: tails the server's event stream as JSON lines.
import { ServerStreamFrameSchema, serverRoutes } from "@agentbox/contracts";
import { asIdentityError } from "@agentbox/contracts/tls";
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
  /** TLS options for the connection, such as `pinnedTlsOptions()` for a pinned server. */
  tls?: object;
  signal?: AbortSignal;
}

/** Builds the `events.stream` WebSocket URL. The token never goes in it. */
export function eventsUrl(baseUrl: string, types?: string): string {
  const url = new URL(serverRoutes["events.stream"].path, baseUrl.replace(/\/$/, "") + "/");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
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
            ? "The server refused the token. Check server.token in the data directory (~/.claude-box or AGENTBOX_DATA_DIR), or AGENTBOX_TOKEN."
            : `The server refused the event stream with status ${res.statusCode}.`,
        ),
      );
    });
    socket.on("error", (err) =>
      finish(asIdentityError(err, new URL(options.baseUrl).host) as Error),
    );
    socket.on("close", () => finish());
  });
}
