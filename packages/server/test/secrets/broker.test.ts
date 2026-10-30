import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../../src/api/errors.js";
import {
  MAX_SOCKET_PATH_BYTES,
  SecretsBroker,
  logSafe,
  type BrokerSource,
} from "../../src/secrets/broker.js";
import { tempDir } from "../tmp.js";

const VALUE = "SYNTHETIC_value_never_logged";
const C = "claude-agent-proj-p-00000000";

/** A source that lists `A` and `B` for project `p-00000000` and nothing else. */
class FakeSource implements BrokerSource {
  listed = ["A", "B"];
  failWith: ApiError | null = null;
  reads: string[][] = [];
  async names(projectId: string) {
    return projectId === "p-00000000" ? this.listed : [];
  }
  async read(projectId: string, names: readonly string[]) {
    this.reads.push([...names]);
    if (this.failWith) throw this.failWith;
    const missing = names.filter((n) => projectId !== "p-00000000" || !this.listed.includes(n));
    if (missing.length > 0) throw new ApiError("not_found", `Not listed: ${missing.join(", ")}`);
    return Object.fromEntries(names.map((n) => [n, `${VALUE}_${n}`]));
  }
}

function request(
  socketPath: string,
  method: string,
  route: string,
  body?: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method, path: route }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

const brokers: SecretsBroker[] = [];
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.closeAll();
});

function makeBroker(options: { now?: () => number; closeGraceMs?: number } = {}) {
  const root = tempDir("agentbox-broker-");
  const source = new FakeSource();
  const log: string[] = [];
  const broker = new SecretsBroker({
    source,
    dirFor: (container) => path.join(root, container),
    log: (m) => log.push(m),
    ...options,
  });
  brokers.push(broker);
  return { root, source, log, broker };
}

describe("SecretsBroker", () => {
  it("serves listed names and values over a private socket, and logs names only", async () => {
    const { root, log, broker } = makeBroker();
    await broker.open({ container: C, projectId: "p-00000000" });
    const socket = broker.socketPath(C);
    expect(socket).toBe(path.join(root, C, "broker.sock"));
    expect(fs.statSync(path.join(root, C)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(socket).mode & 0o777).toBe(0o600);

    expect(await request(socket, "GET", "/v1/names")).toEqual({
      status: 200,
      json: { names: ["A", "B"] },
    });
    const read = await request(
      socket,
      "POST",
      "/v1/read",
      JSON.stringify({ names: ["B", "A", "B"], caller: "agentbox-secret run B\n-- make" }),
    );
    expect(read).toEqual({
      status: 200,
      json: { values: { B: `${VALUE}_B`, A: `${VALUE}_A` } },
    });
    expect(log.join("\n")).not.toContain(VALUE);
    expect(log).toContain(`Secrets broker: ${C} list: ok`);
    expect(log).toContain(`Secrets broker: ${C} read B,A for "agentbox-secret run B -- make": ok`);
  });

  it("maps errors to the broker's codes and statuses without values", async () => {
    const { source, log, broker } = makeBroker();
    await broker.open({ container: C, projectId: "p-00000000" });
    const socket = broker.socketPath(C);

    const unlisted = await request(socket, "POST", "/v1/read", JSON.stringify({ names: ["Z"] }));
    expect(unlisted).toMatchObject({ status: 404, json: { error: { code: "not_found" } } });

    source.failWith = new ApiError("secrets_locked", "The 1Password CLI is not signed in.");
    const locked = await request(socket, "POST", "/v1/read", JSON.stringify({ names: ["A"] }));
    expect(locked).toMatchObject({ status: 503, json: { error: { code: "secrets_locked" } } });

    source.failWith = new ApiError("box_running", "Not a broker code.");
    const other = await request(socket, "POST", "/v1/read", JSON.stringify({ names: ["A"] }));
    expect(other).toMatchObject({ status: 500, json: { error: { code: "internal" } } });

    for (const body of ["{", JSON.stringify({ names: ["bad-name"] }), "x".repeat(20_000)]) {
      const bad = await request(socket, "POST", "/v1/read", body);
      expect(bad).toMatchObject({ status: 400, json: { error: { code: "validation" } } });
    }
    expect(await request(socket, "GET", "/v1/values")).toMatchObject({ status: 404 });
    expect(log.some((l) => l.endsWith("read A: secrets_locked"))).toBe(true);
  });

  it("recreates a socket in place, as after a server restart", async () => {
    const first = makeBroker();
    await first.broker.open({ container: C, projectId: "p-00000000" });
    // A crashed server leaves its socket file behind.
    const socket = first.broker.socketPath(C);
    const stale = new SecretsBroker({
      source: new FakeSource(),
      dirFor: (container) => path.join(first.root, container),
      log: () => undefined,
    });
    brokers.push(stale);
    await stale.open({ container: C, projectId: "p-00000000" });
    expect(await request(socket, "GET", "/v1/names")).toMatchObject({ status: 200 });
    await first.broker.closeAll();
    await stale.closeAll();
    expect(fs.existsSync(socket)).toBe(false);
    expect(fs.existsSync(path.dirname(socket))).toBe(true);
  });

  it("syncs with the running containers, keeping a fresh socket for the grace period", async () => {
    let now = 0;
    const { broker, root } = makeBroker({ now: () => now, closeGraceMs: 1000 });
    const other = "claude-agent-proj-q-00000000";
    await broker.sync([{ container: C, projectId: "p-00000000" }]);
    expect(broker.openContainers()).toEqual([C]);
    // A container opens its socket before docker lists it.
    await broker.open({ container: other, projectId: "q-00000000" });
    await broker.sync([{ container: C, projectId: "p-00000000" }]);
    expect(broker.openContainers()).toEqual([C, other]);
    now = 1000;
    await broker.sync([{ container: other, projectId: "q-00000000" }]);
    expect(broker.openContainers()).toEqual([other]);
    expect(fs.existsSync(path.join(root, C, "broker.sock"))).toBe(false);
    // The same container for another project gets a new socket.
    await broker.open({ container: other, projectId: "p-00000000" });
    expect(await request(broker.socketPath(other), "GET", "/v1/names")).toEqual({
      status: 200,
      json: { names: ["A", "B"] },
    });
  });

  it("refuses a socket path too long for a Unix socket", async () => {
    const { broker, log } = makeBroker();
    const long = `claude-agent-proj-${"x".repeat(MAX_SOCKET_PATH_BYTES)}`;
    await expect(broker.open({ container: long, projectId: "p-00000000" })).rejects.toMatchObject({
      code: "internal",
      message: expect.stringMatching(/at most 107\. Choose a data directory .* shorter\.$/),
    });
    await broker.sync([{ container: long, projectId: "p-00000000" }]);
    expect(log.some((l) => l.includes("can't open the socket"))).toBe(true);
  });

  it("makes caller text safe for a log line", () => {
    expect(logSafe("a\u0000b\nc")).toBe("a b c");
    expect(logSafe("x".repeat(300))).toHaveLength(203);
  });
});
