import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrokerClient, BrokerError, brokerSocketPath } from "../../src/secrets/broker-client.js";
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

  it("refuses the TCP transport, which isn't built", () => {
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
