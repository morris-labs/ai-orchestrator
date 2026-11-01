// The secrets broker's TCP transport, which Docker Desktop needs: a loopback
// listener per container that requires the container's bearer token.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/errors.js";
import { freeLoopbackPort } from "../../src/projects/service.js";
import {
  SecretsBroker,
  bearerMatches,
  newBrokerToken,
  type BrokerSource,
} from "../../src/secrets/broker.js";
import { tempDir } from "../tmp.js";

const VALUE = "SYNTHETIC_value_never_logged";
const C = "aio-agent-proj-p-00000000";
const P = "p-00000000";

class FakeSource implements BrokerSource {
  reads: string[][] = [];
  async names() {
    return ["A", "B"];
  }
  async read(_projectId: string, names: readonly string[]) {
    this.reads.push([...names]);
    const missing = names.filter((n) => n !== "A" && n !== "B");
    if (missing.length > 0) throw new ApiError("not_found", `Not listed: ${missing.join(", ")}`);
    return Object.fromEntries(names.map((n) => [n, `${VALUE}_${n}`]));
  }
}

function request(
  port: number,
  method: string,
  route: string,
  options: { token?: string; authorization?: string; body?: string } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (options.authorization !== undefined) headers.authorization = options.authorization;
  else if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: route, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const brokers: SecretsBroker[] = [];
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.closeAll();
});

function makeBroker(root = tempDir("aio-broker-tcp-")) {
  const source = new FakeSource();
  const log: string[] = [];
  const broker = new SecretsBroker({
    source,
    dirFor: (container) => path.join(root, container),
    log: (m) => log.push(m),
  });
  brokers.push(broker);
  return { root, source, log, broker };
}

function tokenOf(root: string): string {
  return fs.readFileSync(path.join(root, C, "broker.token"), "utf8").trim();
}

/** The listening address of the broker's server for `C`, through its port. */
function boundAddress(broker: SecretsBroker): AddressInfo {
  const sockets = (broker as unknown as { sockets: Map<string, { server: http.Server }> }).sockets;
  return sockets.get(C)!.server.address() as AddressInfo;
}

describe("SecretsBroker over TCP", () => {
  it("serves a request with the container's token, on 127.0.0.1 only", async () => {
    const { root, log, broker, source } = makeBroker();
    const port = await freeLoopbackPort(new Set());
    await broker.open({ container: C, projectId: P, tcpPort: port }, { rotateToken: true });
    expect(broker.tcpPort(C)).toBe(port);
    expect(boundAddress(broker)).toMatchObject({ address: "127.0.0.1", port });

    const token = tokenOf(root);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(path.join(root, C, "broker.token")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(root, C)).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(root, C, "broker.url"), "utf8")).toBe(
      `http://host.docker.internal:${port}\n`,
    );
    expect(fs.existsSync(path.join(root, C, "broker.sock"))).toBe(false);

    expect(await request(port, "GET", "/v1/names", { token })).toEqual({
      status: 200,
      json: { names: ["A", "B"] },
    });
    const read = await request(port, "POST", "/v1/read", {
      token,
      body: JSON.stringify({ names: ["A"], caller: "aio-secret get A" }),
    });
    expect(read).toEqual({ status: 200, json: { values: { A: `${VALUE}_A` } } });
    expect(source.reads).toEqual([["A"]]);
    expect(log.join("\n")).not.toContain(VALUE);
    expect(log.join("\n")).not.toContain(token);
  });

  it("refuses a missing or wrong token with 401, logs it without secrets, and reads nothing", async () => {
    const { root, log, broker, source } = makeBroker();
    const port = await freeLoopbackPort(new Set());
    await broker.open({ container: C, projectId: P, tcpPort: port }, { rotateToken: true });
    const token = tokenOf(root);
    const wrong = newBrokerToken();
    const unauthorized = {
      status: 401,
      json: {
        error: { code: "unauthorized", message: "The secrets broker needs the container's token." },
      },
    };

    expect(await request(port, "GET", "/v1/names")).toEqual(unauthorized);
    expect(await request(port, "GET", "/v1/names", { token: wrong })).toEqual(unauthorized);
    expect(
      await request(port, "POST", "/v1/read", {
        token: `${token}x`,
        body: JSON.stringify({ names: ["A"], caller: VALUE }),
      }),
    ).toEqual(unauthorized);
    expect(await request(port, "GET", "/v1/names", { authorization: token })).toEqual(unauthorized);
    expect(await request(port, "GET", "/v1/names", { authorization: "Basic eDp5" })).toEqual(
      unauthorized,
    );
    expect(source.reads).toEqual([]);

    const text = log.join("\n");
    expect(log).toContain(`Secrets broker: ${C} GET /v1/names: unauthorized (missing token)`);
    expect(log).toContain(`Secrets broker: ${C} GET /v1/names: unauthorized (wrong token)`);
    expect(log).toContain(`Secrets broker: ${C} POST /v1/read: unauthorized (wrong token)`);
    for (const secret of [token, wrong, VALUE, "eDp5"]) expect(text).not.toContain(secret);
  });

  it("rotates the token when the container is created again, and keeps it across a restart", async () => {
    const root = tempDir("aio-broker-tcp-");
    const first = makeBroker(root);
    const port = await freeLoopbackPort(new Set());
    await first.broker.open({ container: C, projectId: P, tcpPort: port }, { rotateToken: true });
    const t1 = tokenOf(root);

    // The container is created again while the listener stays open.
    await first.broker.open({ container: C, projectId: P, tcpPort: port }, { rotateToken: true });
    const t2 = tokenOf(root);
    expect(t2).not.toBe(t1);
    expect((await request(port, "GET", "/v1/names", { token: t1 })).status).toBe(401);
    expect((await request(port, "GET", "/v1/names", { token: t2 })).status).toBe(200);

    // A server restart: the running container still reads the same token.
    await first.broker.closeAll();
    expect(fs.existsSync(path.join(root, C, "broker.token"))).toBe(true);
    const second = makeBroker(root);
    await second.broker.sync([{ container: C, projectId: P, tcpPort: port }]);
    expect(tokenOf(root)).toBe(t2);
    expect((await request(port, "GET", "/v1/names", { token: t2 })).status).toBe(200);
  });

  it("replaces a token file that holds no valid token", async () => {
    const { root, broker } = makeBroker();
    fs.mkdirSync(path.join(root, C), { recursive: true });
    fs.writeFileSync(path.join(root, C, "broker.token"), "short\n", { mode: 0o644 });
    const port = await freeLoopbackPort(new Set());
    await broker.open({ container: C, projectId: P, tcpPort: port });
    expect(tokenOf(root)).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(path.join(root, C, "broker.token")).mode & 0o777).toBe(0o600);
  });

  it("moves between the transports, leaving no file of the other one", async () => {
    const { root, broker } = makeBroker();
    await broker.open({ container: C, projectId: P });
    expect(fs.existsSync(path.join(root, C, "broker.sock"))).toBe(true);

    const port = await freeLoopbackPort(new Set());
    await broker.open({ container: C, projectId: P, tcpPort: port }, { rotateToken: true });
    expect(fs.existsSync(path.join(root, C, "broker.sock"))).toBe(false);
    expect(broker.tcpPort(C)).toBe(port);

    const other = await freeLoopbackPort(new Set([port]));
    await broker.open({ container: C, projectId: P, tcpPort: other });
    expect(broker.tcpPort(C)).toBe(other);
    expect(fs.readFileSync(path.join(root, C, "broker.url"), "utf8")).toContain(`:${other}`);

    await broker.open({ container: C, projectId: P });
    expect(broker.tcpPort(C)).toBeNull();
    expect(fs.existsSync(path.join(root, C, "broker.url"))).toBe(false);
    expect(fs.existsSync(path.join(root, C, "broker.token"))).toBe(false);
    expect(fs.existsSync(path.join(root, C, "broker.sock"))).toBe(true);
  });

  it("fails to open on a taken port and names the port", async () => {
    const { broker } = makeBroker();
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as AddressInfo).port;
    try {
      await expect(broker.open({ container: C, projectId: P, tcpPort: port })).rejects.toThrow(
        `can't listen on 127.0.0.1:${port}`,
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("bearerMatches", () => {
  const token = newBrokerToken();
  const digest = crypto.createHash("sha256").update(token).digest();

  it("accepts the token in a Bearer header, in any case and with surrounding blanks", () => {
    expect(bearerMatches(`Bearer ${token}`, digest)).toBe(true);
    expect(bearerMatches(`bearer  ${token} `, digest)).toBe(true);
  });

  it("refuses anything else", () => {
    expect(bearerMatches(undefined, digest)).toBe(false);
    expect(bearerMatches("", digest)).toBe(false);
    expect(bearerMatches(token, digest)).toBe(false);
    expect(bearerMatches(`Bearer ${token.slice(1)}`, digest)).toBe(false);
    expect(bearerMatches(`Bearer ${token} extra`, digest)).toBe(false);
    expect(bearerMatches("Bearer ", digest)).toBe(false);
    // The digest of an empty token, offered with no header, is still refused.
    const empty = crypto.createHash("sha256").update("").digest();
    expect(bearerMatches(undefined, empty)).toBe(false);
  });
});
