// A fake AI Orchestrator server for CLI tests: canned answers per route and a
// recording of every request.
import https from "node:https";
import type { AddressInfo } from "node:net";
import { createServerIdentity, type TlsIdentity } from "@aio/contracts/tls";
import WebSocket, { WebSocketServer } from "ws";

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  authorization: string | undefined;
}

export type Answer =
  { status?: number; body: unknown } | ((req: Recorded) => { status?: number; body: unknown });

export interface FakeServer {
  url: string;
  /** The certificate the fake serves, PEM; the CLI pins it from the data directory. */
  cert: string;
  requests: Recorded[];
  /** Sets the answer for `"METHOD /path"`. */
  on(route: string, answer: Answer): void;
  /** Frames the event socket sends after the client's hello. */
  events: unknown[];
  /** The query of the last event-socket connection. */
  lastEventsQuery: Record<string, string> | null;
  /** Closes each event socket at once with this code and reason, like a refused query. */
  closeEventsWith: { code: number; reason: string } | null;
  /**
   * Serves terminal sockets, at `/api/v1/terminals` and under the machine
   * proxy prefix; `null` refuses them. `refuseTerminal` refuses them with
   * this status and JSON body instead.
   */
  onTerminal: ((ws: WebSocket, url: URL) => void) | null;
  refuseTerminal: { status: number; body: unknown } | null;
  close(): Promise<void>;
}

export async function startFakeServer(
  token = "cli-test-token",
  identity: TlsIdentity = createServerIdentity(),
): Promise<FakeServer> {
  const answers = new Map<string, Answer>();
  const requests: Recorded[] = [];
  const server = https.createServer({ key: identity.key, cert: identity.cert }, (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const rec: Recorded = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: raw === "" ? undefined : JSON.parse(raw),
        authorization: req.headers.authorization,
      };
      requests.push(rec);
      const key = `${rec.method} ${rec.path}`;
      const answer = answers.get(key);
      const needsAuth = rec.path !== "/api/v1/health";
      if (needsAuth && rec.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "validation", message: "no token" } }));
        return;
      }
      if (!answer) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "not_found", message: `no fake for ${key}` } }));
        return;
      }
      const a = typeof answer === "function" ? answer(rec) : answer;
      res.writeHead(a.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(a.body));
    });
  });
  const fake: FakeServer = {
    url: "",
    cert: identity.cert,
    requests,
    events: [],
    lastEventsQuery: null,
    closeEventsWith: null,
    onTerminal: null,
    refuseTerminal: null,
    on: (route, answer) => void answers.set(route, answer),
    close: () =>
      new Promise((r) => {
        wss.clients.forEach((c) => c.terminate());
        wss.close();
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const terminal = /^\/api\/v1(\/machines\/[^/]+\/proxy)?\/terminals$/.test(url.pathname);
    if (terminal && req.headers.authorization === `Bearer ${token}`) {
      if (fake.refuseTerminal) {
        const body = JSON.stringify(fake.refuseTerminal.body);
        socket.end(
          `HTTP/1.1 ${fake.refuseTerminal.status} Refused\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
        return;
      }
      const serve = fake.onTerminal;
      if (serve) {
        wss.handleUpgrade(req, socket, head, (ws) => serve(ws, url));
        return;
      }
    }
    // Like the server: the bearer header only, never a query token.
    if (
      url.pathname !== "/api/v1/events" ||
      req.headers.authorization !== `Bearer ${token}` ||
      url.searchParams.has("token")
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    fake.lastEventsQuery = Object.fromEntries(url.searchParams);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (fake.closeEventsWith) {
        ws.close(fake.closeEventsWith.code, fake.closeEventsWith.reason);
        return;
      }
      ws.on("message", (m) => {
        const hello = JSON.parse(m.toString()) as { type: string };
        if (hello.type !== "hello") return;
        ws.send(JSON.stringify({ type: "hello", streamId: "srv-1", lastSeq: 0, replaying: false }));
        for (const frame of fake.events) ws.send(JSON.stringify(frame));
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
