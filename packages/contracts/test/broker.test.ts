import { describe, expect, it } from "vitest";
import {
  BROKER_MAX_NAMES,
  BROKER_SOCKET_PATH,
  BROKER_TOKEN_PATH,
  BROKER_URL_PATH,
  BrokerErrorCodeSchema,
  BrokerTransportSettingSchema,
  GlobalSettingsInputSchema,
  brokerTcpUrl,
  BrokerReadRequestSchema,
  BrokerReadResponseSchema,
} from "../src/index.js";

describe("broker protocol", () => {
  it("puts the socket in the read-only broker mount", () => {
    expect(BROKER_SOCKET_PATH).toBe("/run/aio-broker/broker.sock");
  });

  it("accepts a read of valid names with an optional caller", () => {
    expect(
      BrokerReadRequestSchema.parse({ names: ["SYNTHETIC_TOKEN"], caller: "git push" }),
    ).toEqual({ names: ["SYNTHETIC_TOKEN"], caller: "git push" });
  });

  it("refuses an empty, oversized, or malformed read", () => {
    expect(BrokerReadRequestSchema.safeParse({ names: [] }).success).toBe(false);
    const many = Array.from({ length: BROKER_MAX_NAMES + 1 }, (_, i) => `N${i}`);
    expect(BrokerReadRequestSchema.safeParse({ names: many }).success).toBe(false);
    expect(BrokerReadRequestSchema.safeParse({ names: ["BAD-NAME"] }).success).toBe(false);
    expect(BrokerReadRequestSchema.safeParse({ names: ["A"], extra: 1 }).success).toBe(false);
  });

  it("parses values and limits error codes to the broker's", () => {
    expect(BrokerReadResponseSchema.parse({ values: { A: "synthetic" } }).values.A).toBe(
      "synthetic",
    );
    expect(BrokerErrorCodeSchema.safeParse("secrets_locked").success).toBe(true);
    expect(BrokerErrorCodeSchema.safeParse("box_running").success).toBe(false);
  });
});

describe("broker TCP transport", () => {
  it("keeps the token and URL files in the read-only broker mount", () => {
    expect(BROKER_TOKEN_PATH).toBe("/run/aio-broker/broker.token");
    expect(BROKER_URL_PATH).toBe("/run/aio-broker/broker.url");
    expect(brokerTcpUrl(41500)).toBe("http://host.docker.internal:41500");
    expect(BrokerErrorCodeSchema.safeParse("unauthorized").success).toBe(true);
  });

  it("takes auto, unix, or tcp, and leaves the setting out by default", () => {
    expect(BrokerTransportSettingSchema.options).toEqual(["auto", "unix", "tcp"]);
    expect(GlobalSettingsInputSchema.parse({})).not.toHaveProperty("brokerTransport");
    expect(GlobalSettingsInputSchema.parse({ brokerTransport: "tcp" }).brokerTransport).toBe("tcp");
    expect(GlobalSettingsInputSchema.safeParse({ brokerTransport: "ssh" }).success).toBe(false);
  });
});
