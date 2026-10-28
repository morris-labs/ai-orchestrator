import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { DevServerProxy, cachedResolver, parseProxyHost } from "../../src/proxy/proxy.js";
import { TOKEN, createHarness, type Harness } from "../api/harness.js";

const ENGINE_TOKEN = "e".repeat(32);

let engine: http.Server;
let enginePort: number;
let h: Harness;
let port: number;
let seen: {
  url?: string;
  auth?: string;
  host?: string;
  engineToken?: string;
  headers?: http.IncomingHttpHeaders;
}[];

beforeEach(async () => {
  seen = [];
  engine = http.createServer((req, res) => {
    seen.push({
      url: req.url,
      auth: req.headers.authorization,
      host: req.headers.host,
      engineToken: req.headers["x-agentbox-engine-token"] as string | undefined,
      headers: req.headers,
    });
    if (req.url?.includes("/slow")) {
      res.on("close", () => seen.push({ url: "closed" }));
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain", "x-engine": "yes" });
      res.end(`${req.method} ${req.url} ${body}`);
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  engine.on("upgrade", (req, socket, head) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    wss.handleUpgrade(req, socket, head, (ws) =>
      ws.on("message", (d) => ws.send(`echo:${d.toString()}`)),
    );
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  enginePort = (engine.address() as { port: number }).port;
  const proxy = new DevServerProxy(
    cachedResolver(async (hostKey) =>
      hostKey === "emails" ? { enginePort, token: ENGINE_TOKEN } : null,
    ),
  );
  h = await createHarness({ proxy });
  port = await h.server.listen(0);
});

afterEach(async () => {
  await h.server.close();
  engine.closeAllConnections();
  await new Promise((r) => engine.close(r));
});

function request(
  host: string,
  path: string,
  method = "GET",
  body?: string,
  extra: http.OutgoingHttpHeaders = {},
) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
    (resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path, method, headers: { host, ...extra } },
        (res) => {
          let data = "";
          res.on("data", (d) => (data += d));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    },
  );
}

describe("parseProxyHost", () => {
  it("reads the port and host key", () => {
    expect(parseProxyHost("3000.emails.localhost:20400")).toEqual({
      port: 3000,
      hostKey: "emails",
    });
    expect(parseProxyHost("8080.my-box.localhost")).toEqual({ port: 8080, hostKey: "my-box" });
    expect(parseProxyHost("127.0.0.1:20400")).toBeNull();
    expect(parseProxyHost("99999.emails.localhost")).toBeNull();
    expect(parseProxyHost("3000.-bad.localhost")).toBeNull();
    expect(parseProxyHost(undefined)).toBeNull();
  });
});

describe("dev-server proxy", () => {
  it("forwards HTTP to the engine's /proxy/<port>/ with the engine token and no API token", async () => {
    const res = await request(
      `3000.emails.localhost:${port}`,
      "/assets/app.js?v=1",
      "POST",
      "data",
    );
    expect(res.status).toBe(200);
    expect(res.headers["x-engine"]).toBe("yes");
    expect(res.body).toBe("POST /proxy/3000/assets/app.js?v=1 data");
    expect(seen[0]?.auth).toBe(`Bearer ${ENGINE_TOKEN}`);
    expect(seen[0]?.engineToken).toBe(ENGINE_TOKEN);
  });

  it("passes the browser's Authorization header and drops hop-by-hop headers", async () => {
    const res = await request(`3000.emails.localhost:${port}`, "/api/me", "GET", undefined, {
      authorization: "Bearer user-jwt",
      "proxy-authorization": "Basic secret",
      "x-agentbox-engine-token": "spoofed",
      te: "trailers",
      connection: "keep-alive, x-drop-me",
      "x-drop-me": "1",
    });
    expect(res.status).toBe(200);
    expect(seen[0]?.auth).toBe("Bearer user-jwt");
    expect(seen[0]?.engineToken).toBe(ENGINE_TOKEN);
    expect(seen[0]?.headers).not.toHaveProperty("proxy-authorization");
    expect(seen[0]?.headers).not.toHaveProperty("te");
    expect(seen[0]?.headers).not.toHaveProperty("x-drop-me");
  });

  it("ends the engine request when the browser disconnects", async () => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/slow",
      headers: { host: `3000.emails.localhost:${port}` },
    });
    req.on("error", () => undefined);
    req.end();
    await expect.poll(() => seen.length).toBe(1);
    req.destroy();
    await expect.poll(() => seen.some((s) => s.url === "closed")).toBe(true);
  });

  it("answers 502 for an unknown host key", async () => {
    const res = await request(`3000.nobody.localhost:${port}`, "/");
    expect(res.status).toBe(502);
  });

  it("leaves API requests to the API", async () => {
    const res = await request(`127.0.0.1:${port}`, "/api/v1/health");
    expect(JSON.parse(res.body).version).toBe("4.0.0-dev");
  });

  it("forwards WebSocket upgrades", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/hmr`, {
      headers: { host: `5173.emails.localhost:${port}` },
    });
    await new Promise((r) => ws.once("open", r));
    ws.send("ping");
    const reply = await new Promise<string>((r) => ws.once("message", (d) => r(d.toString())));
    expect(reply).toBe("echo:ping");
    expect(seen[0]).toMatchObject({ url: `/proxy/5173/hmr?token=${ENGINE_TOKEN}` });
    expect(seen[0]?.auth).toBeUndefined();
    ws.close();
  });

  it("keeps the browser's Authorization header on an upgrade", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/hmr?x=1`, {
      headers: { host: `5173.emails.localhost:${port}`, authorization: "Bearer user-jwt" },
    });
    await new Promise((r) => ws.once("open", r));
    expect(seen[0]).toMatchObject({
      url: `/proxy/5173/hmr?x=1&token=${ENGINE_TOKEN}`,
      auth: "Bearer user-jwt",
    });
    ws.close();
  });

  it("keeps API WebSockets working next to the proxy", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events?token=${TOKEN}`);
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "hello", streamId: null, lastSeq: null }));
    const hello = await new Promise<string>((r) => ws.once("message", (d) => r(d.toString())));
    expect(JSON.parse(hello).type).toBe("hello");
    ws.close();
  });
});
