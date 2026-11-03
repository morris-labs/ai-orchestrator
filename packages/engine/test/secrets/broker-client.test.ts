import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrokerClient,
  BrokerError,
  brokerEndpoint,
  brokerSocketPath,
  parseBrokerUrl,
} from "../../src/secrets/broker-client.js";
import { tempDir } from "../tmp.js";
import { startFakeBroker, type FakeBroker } from "./fake-broker.js";

const brokers: FakeBroker[] = [];
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.close();
});

async function broker(...args: Parameters<typeof startFakeBroker>) {
  const b = await startFakeBroker(...args);
  brokers.push(b);
  return b;
}

describe("brokerSocketPath", () => {
  it("uses the variable, else the mounted default", () => {
    expect(brokerSocketPath({ AIO_BROKER_SOCKET: "/x/broker.sock" })).toBe("/x/broker.sock");
    expect(brokerSocketPath({})).toBe("/run/aio-broker/broker.sock");
  });

  it("has no socket path for a TCP broker", () => {
    expect(() => brokerSocketPath({ AIO_BROKER_URL: "http://host.docker.internal:1" })).toThrow(
      expect.objectContaining({ code: "unsupported" }),
    );
  });
});

describe("BrokerClient", () => {
  it("lists names and reads values, all or nothing", async () => {
    const b = await broker({ SYNTHETIC_A: "one", SYNTHETIC_B: "two" });
    const client = new BrokerClient({ socketPath: b.socketPath });
    expect(await client.names()).toEqual(["SYNTHETIC_A", "SYNTHETIC_B"]);
    expect(await client.read(["SYNTHETIC_B", "SYNTHETIC_B"], "test")).toEqual({
      SYNTHETIC_B: "two",
    });
    expect(b.reads).toEqual([{ names: ["SYNTHETIC_B"], caller: "test" }]);
    expect(await client.read([])).toEqual({});
    const err = await client.read(["SYNTHETIC_A", "MISSING"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err).toMatchObject({ code: "not_found" });
  });

  it("passes the broker's error codes on", async () => {
    const b = await broker(
      {},
      { status: 503, code: "secrets_locked", message: "The 1Password CLI is not signed in." },
    );
    await expect(new BrokerClient({ socketPath: b.socketPath }).names()).rejects.toMatchObject({
      code: "secrets_locked",
      message: "The 1Password CLI is not signed in.",
    });
    const odd = await broker({}, { status: 409, code: "box_running", message: "odd" });
    await expect(new BrokerClient({ socketPath: odd.socketPath }).names()).rejects.toMatchObject({
      code: "internal",
    });
  });

  it("reports a missing broker as unreachable", async () => {
    const socketPath = path.join(tempDir("aio-no-broker-"), "broker.sock");
    await expect(new BrokerClient({ socketPath }).names()).rejects.toMatchObject({
      code: "unreachable",
      message: expect.stringContaining(socketPath),
    });
  });
});

describe("brokerEndpoint", () => {
  const noFile = () => null;

  it("takes the URL first, then the socket variable, then the URL file, then the default socket", () => {
    expect(
      brokerEndpoint(
        { AIO_BROKER_URL: "http://host.docker.internal:41500", AIO_BROKER_SOCKET: "/x.sock" },
        noFile,
      ),
    ).toEqual({
      transport: "tcp",
      host: "host.docker.internal",
      port: 41500,
      url: "http://host.docker.internal:41500",
      tokenFile: "/run/aio-broker/broker.token",
    });
    const files: Record<string, string> = {
      "/run/aio-broker/broker.url": "http://host.docker.internal:41600\n",
    };
    const read = (f: string) => files[f] ?? null;
    expect(brokerEndpoint({ AIO_BROKER_SOCKET: "/x.sock" }, read)).toEqual({
      transport: "unix",
      socketPath: "/x.sock",
    });
    // The engine withholds AIO_ variables from its children; they find the file.
    expect(brokerEndpoint({}, read)).toMatchObject({ transport: "tcp", port: 41600 });
    expect(brokerEndpoint({}, noFile)).toEqual({
      transport: "unix",
      socketPath: "/run/aio-broker/broker.sock",
    });
    expect(brokerEndpoint({}, () => "  \n")).toMatchObject({ transport: "unix" });
  });

  it("refuses a URL the broker doesn't serve", () => {
    for (const url of [
      "https://host.docker.internal:41500",
      "http://host.docker.internal",
      "http://host.docker.internal:41500/v1",
      "http://user:pw@host.docker.internal:41500",
      "http://host.docker.internal:41500?x=1",
      "host.docker.internal:41500",
      "not a url",
    ]) {
      expect(() => parseBrokerUrl(url), url).toThrow(
        expect.objectContaining({ code: "unsupported" }),
      );
    }
    expect(parseBrokerUrl("http://127.0.0.1:41500/")).toMatchObject({
      host: "127.0.0.1",
      port: 41500,
    });
    expect(parseBrokerUrl("http://[::1]:41500")).toMatchObject({ host: "::1", port: 41500 });
  });
});

describe("BrokerClient over TCP", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });

  /** A TCP broker on 127.0.0.1 that wants `token`; records the headers it saw. */
  async function tcpBroker(token: string) {
    const seen: (string | undefined)[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      req.resume();
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.headers.authorization !== `Bearer ${token}`) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: { code: "unauthorized", message: "no" } }));
          return;
        }
        res.end(JSON.stringify({ names: ["SYNTHETIC_A"] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    return { port: (server.address() as AddressInfo).port, seen };
  }

  it("sends the token from the file, read again for each call", async () => {
    const dir = tempDir("aio-tcp-client-");
    const tokenFile = path.join(dir, "broker.token");
    fs.writeFileSync(tokenFile, "a".repeat(64) + "\n");
    const b = await tcpBroker("a".repeat(64));
    const client = new BrokerClient({
      endpoint: parseBrokerUrl(`http://127.0.0.1:${b.port}`, tokenFile),
    });
    expect(await client.names()).toEqual(["SYNTHETIC_A"]);
    expect(b.seen).toEqual([`Bearer ${"a".repeat(64)}`]);

    // A rotated token, as after the container was created again.
    fs.writeFileSync(tokenFile, "b".repeat(64) + "\n");
    const err = await client.names().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err).toMatchObject({ code: "unreachable", message: expect.stringContaining("token") });
    expect((err as Error).message).not.toContain("b".repeat(64));
  });

  it("chooses TCP from the environment", async () => {
    const b = await tcpBroker("c".repeat(64));
    const client = new BrokerClient({
      env: { AIO_BROKER_URL: `http://127.0.0.1:${b.port}` },
      readText: (f) => (f === "/run/aio-broker/broker.token" ? "c".repeat(64) : null),
    });
    expect(client.endpoint.transport).toBe("tcp");
    expect(client.socketPath).toBe(`http://127.0.0.1:${b.port}`);
    expect(await client.names()).toEqual(["SYNTHETIC_A"]);
  });

  it("reports a missing token file or a stopped broker as unreachable", async () => {
    const dir = tempDir("aio-tcp-client-");
    const b = await tcpBroker("d".repeat(64));
    const noToken = new BrokerClient({
      endpoint: parseBrokerUrl(`http://127.0.0.1:${b.port}`, path.join(dir, "missing")),
    });
    await expect(noToken.names()).rejects.toMatchObject({
      code: "unreachable",
      message: expect.stringContaining("token"),
    });
    expect(b.seen).toEqual([]);

    const tokenFile = path.join(dir, "broker.token");
    fs.writeFileSync(tokenFile, "d".repeat(64));
    const closed = await new Promise<number>((resolve) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
    const stopped = new BrokerClient({
      endpoint: parseBrokerUrl(`http://127.0.0.1:${closed}`, tokenFile),
    });
    await expect(stopped.names()).rejects.toMatchObject({
      code: "unreachable",
      message: expect.stringContaining(`http://127.0.0.1:${closed}`),
    });
  });

  it("gives up after the timeout when the name lookup hangs", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockImplementation((() => undefined) as never);
    try {
      const client = new BrokerClient({
        endpoint: parseBrokerUrl("http://broker.example.com:41000"),
        readText: () => "e".repeat(64),
        timeoutMs: 50,
      });
      await expect(client.names()).rejects.toMatchObject({
        code: "unreachable",
        message: expect.stringContaining("no answer within"),
      });
      expect(lookup).toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it("gives up after the timeout when a connected broker doesn't answer", async () => {
    const server = http.createServer(() => undefined);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const client = new BrokerClient({
      endpoint: parseBrokerUrl(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
      readText: () => "f".repeat(64),
      timeoutMs: 50,
    });
    await expect(client.names()).rejects.toMatchObject({
      code: "unreachable",
      message: expect.stringContaining("no answer within"),
    });
  });
});
