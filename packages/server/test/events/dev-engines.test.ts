import { describe, expect, it } from "vitest";
import { projectContainerName } from "@aio/contracts";
import {
  assertDevEnginesAllowed,
  isLoopbackHost,
  parseDevEngines,
  withDevEngines,
} from "../../src/events/dev-engines.js";
import type { EngineEndpoint } from "../../src/api/core-interface.js";

const TOKEN = "abcdefghijklmnopqrstuvwx";
const A = "repo-1e4b6202";
const B = "other-0a1b2c3d";

describe("isLoopbackHost", () => {
  it("accepts loopback names and addresses only", () => {
    for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ["0.0.0.0", "10.0.0.1", "example.com", "::", ""]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe("parseDevEngines", () => {
  it("returns nothing when the variable is unset or blank", () => {
    expect(parseDevEngines(undefined)).toEqual([]);
    expect(parseDevEngines("  ")).toEqual([]);
  });

  it("parses entries into endpoints named after the project container", () => {
    expect(parseDevEngines(`${A}=127.0.0.1:20599:${TOKEN}, ${B}=::1:20600:${TOKEN}`)).toEqual([
      { container: projectContainerName(A), projectId: A, hostPort: 20599, token: TOKEN },
      { container: projectContainerName(B), projectId: B, hostPort: 20600, token: TOKEN },
    ]);
  });

  it("rejects bad entries without echoing the token", () => {
    const bad = [
      `127.0.0.1:20599:${TOKEN}`,
      `not_an_id=127.0.0.1:20599:${TOKEN}`,
      `${A}=10.0.0.5:20599:${TOKEN}`,
      `${A}=127.0.0.1:0:${TOKEN}`,
      `${A}=127.0.0.1:x:${TOKEN}`,
      `${A}=127.0.0.1:20599:short`,
      `${A}=${TOKEN}`,
      `${A}=127.0.0.1:20599:${TOKEN},${A}=127.0.0.1:20600:${TOKEN}`,
    ];
    for (const value of bad) {
      let message = "";
      try {
        parseDevEngines(value);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, value).toMatch(/AIO_DEV_ENGINES entry \d/);
      expect(message).not.toContain(TOKEN);
    }
  });
});

describe("assertDevEnginesAllowed", () => {
  const dev = parseDevEngines(`${A}=127.0.0.1:20599:${TOKEN}`);

  it("allows development engines on a loopback bind address", () => {
    expect(() => assertDevEnginesAllowed(dev, "127.0.0.1")).not.toThrow();
    expect(() => assertDevEnginesAllowed([], "0.0.0.0")).not.toThrow();
  });

  it("refuses them on any other bind address", () => {
    expect(() => assertDevEnginesAllowed(dev, "0.0.0.0")).toThrow(/loopback/);
  });
});

describe("withDevEngines", () => {
  it("adds development engines unless a container for the project already runs", async () => {
    const live: EngineEndpoint = {
      container: projectContainerName(A),
      projectId: A,
      hostPort: 31000,
      token: "live-token-0123456789",
    };
    const dev = parseDevEngines(`${A}=127.0.0.1:20599:${TOKEN},${B}=127.0.0.1:20600:${TOKEN}`);
    const merged = withDevEngines({ list: async () => [live] }, dev);
    expect((await merged.list()).map((e) => [e.projectId, e.hostPort])).toEqual([
      [A, 31000],
      [B, 20600],
    ]);
    const core = { list: async () => [] };
    expect(withDevEngines(core, [])).toBe(core);
  });
});
