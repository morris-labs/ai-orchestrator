// A fake Agent Box server for CLI tests: canned answers per route and a
// recording of every request.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";

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
  requests: Recorded[];
  /** Sets the answer for `"METHOD /path"`. */
  on(route: string, answer: Answer): void;
  /** Frames the event socket sends after the client's hello. */
  events: unknown[];
  /** The query of the last event-socket connection. */
  lastEventsQuery: Record<string, string> | null;
  /** Closes each event socket at once with this code and reason, like a refused query. */
  closeEventsWith: { code: number; reason: string } | null;
  close(): Promise<void>;
}

export async function startFakeServer(token = "cli-test-token"): Promise<FakeServer> {
  const answers = new Map<string, Answer>();
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
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
    requests,
    events: [],
    lastEventsQuery: null,
    closeEventsWith: null,
    on: (route, answer) => void answers.set(route, answer),
    close: () =>
      new Promise((r) => {
        wss.clients.forEach((c) => c.terminate());
        wss.close();
        server.close(() => r());
      }),
  };
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://fake");
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
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
