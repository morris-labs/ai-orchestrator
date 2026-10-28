// A fake engine on a real socket: the health route, a run route, and the
// event socket with hello, replay, and lease frames.
import http from "node:http";
import type { AgentBoxEvent, LeaseResponse } from "@agentbox/contracts";
import WebSocket, { WebSocketServer } from "ws";
import { RUN, runState } from "../api/fixtures.js";

export const ENGINE_TOKEN = "e".repeat(32);

export class FakeEngineServer {
  server!: http.Server;
  port = 0;
  version = "4.0.0-dev";
  streamId = "engine-stream-1";
  events: AgentBoxEvent[] = [];
  hellos: unknown[] = [];
  leaseResponses: LeaseResponse[] = [];
  sockets: WebSocket[] = [];
  healthCalls = 0;

  async start(port = 0): Promise<this> {
    this.server = http.createServer((req, res) => {
      if (req.url === "/api/v1/health") {
        this.healthCalls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            version: this.version,
            uptimeS: 1,
            engineVersion: this.version,
            container: "claude-agent-proj-example-app-1a2b3c4d",
            projectRoot: "/work/example-app",
            streamId: this.streamId,
          }),
        );
        return;
      }
      if (req.headers.authorization !== `Bearer ${ENGINE_TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      if (req.url === "/api/v1/runs") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ runs: [runState] }));
        return;
      }
      if (req.url === `/api/v1/runs/${RUN}`) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(runState));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "run_not_found", message: "No such run." } }));
    });
    const wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      if (!req.url?.includes(`token=${ENGINE_TOKEN}`)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    });
    await new Promise<void>((r) => this.server.listen(port, "127.0.0.1", r));
    this.port = (this.server.address() as { port: number }).port;
    return this;
  }

  private accept(ws: WebSocket): void {
    this.sockets.push(ws);
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { type: string; streamId?: string | null; lastSeq?: number | null; response?: LeaseResponse };
      if (frame.type === "hello") {
        this.hellos.push(frame);
        const replaying = frame.streamId === this.streamId;
        const last = this.events.at(-1)?.seq ?? 0;
        ws.send(JSON.stringify({ type: "hello", streamId: this.streamId, lastSeq: last, replaying }));
        if (replaying) {
          for (const e of this.events) if (e.seq > (frame.lastSeq ?? 0)) ws.send(JSON.stringify(e));
        }
      } else if (frame.type === "lease.response" && frame.response) {
        this.leaseResponses.push(frame.response);
      }
    });
  }

  /** Emits an engine event to every connected socket. */
  emit(event: Omit<AgentBoxEvent, "seq" | "sourceSeq" | "streamId" | "source" | "id" | "time">): void {
    const seq = (this.events.at(-1)?.seq ?? 0) + 1;
    const full = {
      ...event,
      id: `e${seq}`,
      time: "2026-10-28T09:00:00.000Z",
      source: "engine:claude-agent-proj-example-app-1a2b3c4d",
      streamId: this.streamId,
      seq,
      sourceSeq: seq,
    } as AgentBoxEvent;
    this.events.push(full);
    for (const ws of this.sockets) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(full));
  }

  sendRaw(frame: unknown): void {
    for (const ws of this.sockets) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  dropSockets(): void {
    for (const ws of this.sockets) ws.terminate();
    this.sockets = [];
  }

  async stop(): Promise<void> {
    this.dropSockets();
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out.");
    await new Promise((r) => setTimeout(r, 5));
  }
}
