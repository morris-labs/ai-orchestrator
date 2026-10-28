// `/proxy/:port/*` against local HTTP and WebSocket servers.
import http from "node:http";
import net from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { parseProxyUrl } from "../../src/proxy/proxy.js";
import { TOKEN, listenEngine } from "../api/fixtures.js";

describe("parseProxyUrl", () => {
  it("splits the port and the upstream path", () => {
    expect(parseProxyUrl("/proxy/5173/")).toEqual({ port: 5173, path: "/" });
    expect(parseProxyUrl("/proxy/5173")).toEqual({ port: 5173, path: "/" });
    expect(parseProxyUrl("/proxy/80/a/b?x=1")).toEqual({ port: 80, path: "/a/b?x=1" });
    expect(parseProxyUrl("/proxy/80?x=1")).toEqual({ port: 80, path: "/?x=1" });
  });

  it("drops only a token parameter equal to the engine token", () => {
    expect(parseProxyUrl("/proxy/80/a?token=t&x=1", "t")).toEqual({ port: 80, path: "/a?x=1" });
    expect(parseProxyUrl("/proxy/80/a?token=t", "t")).toEqual({ port: 80, path: "/a" });
    expect(parseProxyUrl("/proxy/80/a?token=app", "t")).toEqual({ port: 80, path: "/a?token=app" });
  });

  it("drops an encoded token key too", () => {
    expect(parseProxyUrl("/proxy/80/a?%74oken=t&x=1", "t")).toEqual({ port: 80, path: "/a?x=1" });
    expect(parseProxyUrl("/proxy/80/a?token=%74", "t")).toEqual({ port: 80, path: "/a" });
  });

  it("rejects other URLs and bad ports", () => {
    expect(parseProxyUrl("/proxy/abc/")).toBeNull();
    expect(parseProxyUrl("/proxy/0/")).toBeNull();
    expect(parseProxyUrl("/proxy/70000/")).toBeNull();
    expect(parseProxyUrl("/api/v1/health")).toBeNull();
  });
});

describe("proxy", () => {
  let upstream: http.Server;
  let wss: WebSocketServer;
  let upstreamPort = 0;
  const seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] =
    [];
  let engine: Awaited<ReturnType<typeof listenEngine>>;
  const wsHeaders: http.IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(201, { "x-upstream": "yes", "set-cookie": ["a=1", "b=2"] });
        res.end(`echo:${body}`);
      });
    });
    wss = new WebSocketServer({ server: upstream });
    wss.on("connection", (socket, req) => {
      wsHeaders.push(req.headers);
      socket.send(`hello ${req.url}`);
      socket.on("message", (m) => socket.send(`echo ${m.toString()}`));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    upstreamPort = (upstream.address() as net.AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

  beforeEach(async () => {
    seen.length = 0;
    engine = await listenEngine();
  });
  afterEach(() => engine.app.close());

  const auth = { authorization: `Bearer ${TOKEN}` };

  it("forwards a request with its method, path, query, headers, and body", async () => {
    const res = await fetch(`${engine.base}/proxy/${upstreamPort}/api/items?q=1`, {
      method: "POST",
      headers: { ...auth, "x-custom": "kept", "content-type": "text/plain" },
      body: "payload",
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-upstream")).toBe("yes");
    expect(res.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(await res.text()).toBe("echo:payload");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/api/items?q=1", body: "payload" });
    expect(seen[0]?.headers["x-custom"]).toBe("kept");
    expect(seen[0]?.headers.host).toBe(`127.0.0.1:${engine.port}`);
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it("accepts the engine-token header and passes the browser's Authorization through", async () => {
    const res = await fetch(`${engine.base}/proxy/${upstreamPort}/app`, {
      headers: { "x-agentbox-engine-token": TOKEN, authorization: "Basic YXBwOmFwcA==" },
    });
    expect(res.status).toBe(201);
    expect(seen[0]?.headers.authorization).toBe("Basic YXBwOmFwcA==");
    expect(seen[0]?.headers["x-agentbox-engine-token"]).toBeUndefined();
  });

  it("refuses a wrong engine-token header", async () => {
    const res = await fetch(`${engine.base}/proxy/${upstreamPort}/`, {
      headers: { "x-agentbox-engine-token": "wrong-token-0123456789" },
    });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("strips the engine token in every bearer spelling it accepts", async () => {
    const res = await fetch(`${engine.base}/proxy/${upstreamPort}/`, {
      headers: { authorization: `bearer   ${TOKEN}` },
    });
    expect(res.status).toBe(201);
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it("strips the engine-token header from a WebSocket upgrade", async () => {
    const socket = new WebSocket(`${engine.ws}/proxy/${upstreamPort}/`, {
      headers: { "x-agentbox-engine-token": TOKEN, authorization: "Basic YXBwOmFwcA==" },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("message", () => resolve());
      socket.on("error", reject);
    });
    socket.close();
    const headers = wsHeaders.at(-1);
    expect(headers?.["x-agentbox-engine-token"]).toBeUndefined();
    expect(headers?.authorization).toBe("Basic YXBwOmFwcA==");
  });

  it("refuses a request whose Authorization header isn't the engine token", async () => {
    const res = await fetch(`${engine.base}/proxy/${upstreamPort}/`, {
      headers: { authorization: "Basic YXBwOmFwcA==" },
    });
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("refuses a request without the engine token", async () => {
    const res = await fetch(`${engine.base}/proxy/${upstreamPort}/`);
    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("answers 502 when nothing listens on the port", async () => {
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const res = await fetch(`${engine.base}/proxy/${port}/`, { headers: auth });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("forwards a WebSocket with the query token removed", async () => {
    const socket = new WebSocket(`${engine.ws}/proxy/${upstreamPort}/live?token=${TOKEN}&room=7`);
    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.on("message", (m) => {
        messages.push(m.toString());
        if (messages.length === 1) socket.send("ping");
        if (messages.length === 2) resolve();
      });
      socket.on("error", reject);
    });
    socket.close();
    expect(messages).toEqual(["hello /live?room=7", "echo ping"]);
  });

  it("forwards a WebSocket authenticated by header", async () => {
    const socket = new WebSocket(`${engine.ws}/proxy/${upstreamPort}/`, { headers: auth });
    const first = await new Promise<string>((resolve, reject) => {
      socket.once("message", (m) => resolve(m.toString()));
      socket.on("error", reject);
    });
    socket.close();
    expect(first).toBe("hello /");
  });

  it("refuses a WebSocket without the token", async () => {
    const socket = new WebSocket(`${engine.ws}/proxy/${upstreamPort}/`);
    const status = await new Promise<number>((resolve) =>
      socket.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)),
    );
    expect(status).toBe(401);
  });

  it("refuses an upgrade on an unknown path", async () => {
    const socket = new WebSocket(`${engine.ws}/api/v1/other?token=${TOKEN}`);
    const status = await new Promise<number>((resolve) =>
      socket.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)),
    );
    expect(status).toBe(404);
  });
});
