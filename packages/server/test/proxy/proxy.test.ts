import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import {
  DevServerProxy,
  cachedResolver,
  crossSiteReason,
  parseProxyHost,
  proxyPorts,
  type ProxyTarget,
} from "../../src/proxy/proxy.js";
import { TOKEN, createHarness, type Harness } from "../api/harness.js";

const ENGINE_TOKEN = "e".repeat(32);

let engine: http.Server;
let enginePort: number;
let h: Harness;
let port: number;
let proxy: DevServerProxy;
let serverClosed: boolean;
/** The ports the box with the host key `emails` serves. */
const SERVED = new Set([3000, 5173]);
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
    seen.push({
      url: req.url,
      auth: req.headers.authorization,
      engineToken: req.headers["x-agentbox-engine-token"] as string | undefined,
    });
    wss.handleUpgrade(req, socket, head, (ws) =>
      ws.on("message", (d) => ws.send(`echo:${d.toString()}`)),
    );
  });
  await new Promise<void>((r) => engine.listen(0, "127.0.0.1", r));
  enginePort = (engine.address() as { port: number }).port;
  proxy = new DevServerProxy(
    cachedResolver(async (hostKey) =>
      hostKey === "emails"
        ? { enginePort, token: ENGINE_TOKEN, allowsPort: (p) => SERVED.has(p) }
        : null,
    ),
  );
  h = await createHarness({ proxy });
  port = await h.server.listen(0);
  serverClosed = false;
});

afterEach(async () => {
  if (!serverClosed) await h.server.close();
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
    expect(parseProxyHost("3000.emails.localhost:21400")).toEqual({
      port: 3000,
      hostKey: "emails",
    });
    expect(parseProxyHost("8080.my-box.localhost")).toEqual({ port: 8080, hostKey: "my-box" });
    expect(parseProxyHost("127.0.0.1:21400")).toBeNull();
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
    expect(seen[0]?.auth).toBeUndefined();
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
    expect(seen[0]).toEqual({ url: "/proxy/5173/hmr", auth: undefined, engineToken: ENGINE_TOKEN });
    ws.close();
  });

  it("keeps the browser's Authorization header and query on an upgrade", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/hmr?x=1`, {
      headers: {
        host: `5173.emails.localhost:${port}`,
        authorization: "Bearer user-jwt",
        "x-agentbox-engine-token": "spoofed",
      },
    });
    await new Promise((r) => ws.once("open", r));
    expect(seen[0]).toEqual({
      url: "/proxy/5173/hmr?x=1",
      auth: "Bearer user-jwt",
      engineToken: ENGINE_TOKEN,
    });
    ws.close();
  });

  it("keeps API WebSockets working next to the proxy", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "hello", streamId: null, lastSeq: null }));
    const hello = await new Promise<string>((r) => ws.once("message", (d) => r(d.toString())));
    expect(JSON.parse(hello).type).toBe("hello");
    ws.close();
  });
});

describe("cross-site requests", () => {
  const host = () => `3000.emails.localhost:${port}`;

  it("refuses a request that another site sends", async () => {
    const res = await request(host(), "/api/delete", "POST", "x", {
      origin: "https://attacker.example.com",
      "sec-fetch-site": "cross-site",
    });
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("refuses another port's origin and an opaque origin", async () => {
    for (const extra of [
      { origin: `http://5173.emails.localhost:${port}`, "sec-fetch-site": "same-site" },
      { origin: `http://5173.emails.localhost:${port}` },
      { origin: "null" },
    ]) {
      expect((await request(host(), "/", "POST", "x", extra)).status).toBe(403);
    }
    expect(seen).toHaveLength(0);
  });

  it("allows a page on the proxy host itself and the person's own navigation", async () => {
    const same = await request(host(), "/api/save", "POST", "x", {
      origin: `http://${host()}`,
      "sec-fetch-site": "same-origin",
    });
    expect(same.status).toBe(200);
    const typed = await request(host(), "/", "GET", undefined, { "sec-fetch-site": "none" });
    expect(typed.status).toBe(200);
  });

  it("refuses a cross-site WebSocket upgrade", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/hmr`, {
      headers: { host: `5173.emails.localhost:${port}` },
      origin: "https://attacker.example.com",
    });
    ws.on("error", () => undefined);
    const status = await new Promise<number>((resolve) =>
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)),
    );
    expect(status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("reads Origin and Sec-Fetch-Site", () => {
    const req = (headers: http.IncomingHttpHeaders) => ({ headers }) as http.IncomingMessage;
    const h = "3000.emails.localhost:21400";
    expect(crossSiteReason(req({ host: h }))).toBeNull();
    expect(crossSiteReason(req({ host: h, origin: `http://${h.toUpperCase()}` }))).toBeNull();
    expect(crossSiteReason(req({ host: h, "sec-fetch-site": "same-site" }))).not.toBeNull();
    expect(crossSiteReason(req({ host: h, origin: "not a url" }))).not.toBeNull();
    expect(crossSiteReason(req({ host: h, origin: "http://127.0.0.1:21400" }))).not.toBeNull();
  });
});

describe("proxied ports", () => {
  it("refuses a port the box doesn't serve, such as the engine's own", async () => {
    const res = await request(`20411.emails.localhost:${port}`, "/api/v1/health");
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("counts the box's own listeners and the project's mapped ports only", () => {
    let listeners: { port: number; boxId: string | null }[] = [
      { port: 3000, boxId: "B1" },
      { port: 4000, boxId: "B2" },
      { port: 20411, boxId: null },
    ];
    const check = proxyPorts("B1", () => listeners, [8080]);
    expect([3000, 4000, 20411, 8080, 9000].map((p) => check.allowsPort(p))).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
    // A listener change counts at once, without waiting for the resolver cache.
    listeners = [{ port: 9000, boxId: "B1" }];
    expect(check.allowsPort(3000)).toBe(false);
    expect(check.allowsPort(9000)).toBe(true);
  });
});

describe("cachedResolver", () => {
  const target: ProxyTarget = { enginePort: 1, token: "t", allowsPort: () => true };

  it("keeps at most the given number of host keys", async () => {
    const asked: string[] = [];
    const resolve = cachedResolver(
      async (key) => {
        asked.push(key);
        return key === "real" ? target : null;
      },
      60_000,
      3,
    );
    await resolve("real");
    for (const key of ["made-up-1", "made-up-2", "made-up-3"]) await resolve(key);
    // `real` was the oldest of four keys, so the fourth pushed it out.
    await resolve("real");
    expect(asked.filter((k) => k === "real")).toHaveLength(2);
    await resolve("made-up-3");
    expect(asked.filter((k) => k === "made-up-3")).toHaveLength(1);
  });

  it("asks again once an entry expires", async () => {
    let calls = 0;
    const resolve = cachedResolver(async () => {
      calls += 1;
      return target;
    }, 0);
    await resolve("a");
    await resolve("a");
    expect(calls).toBe(2);
  });
});

describe("closing the proxy", () => {
  async function openSocket() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/hmr`, {
      headers: { host: `5173.emails.localhost:${port}` },
    });
    await new Promise((r) => ws.once("open", r));
    return { ws, closed: new Promise((r) => ws.once("close", r)) };
  }

  it("destroys the upgraded sockets it holds", async () => {
    const { ws, closed } = await openSocket();
    proxy.close();
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it("lets the API server close while a proxied WebSocket is open", async () => {
    const { closed } = await openSocket();
    serverClosed = true;
    await h.server.close();
    await closed;
  });
});
