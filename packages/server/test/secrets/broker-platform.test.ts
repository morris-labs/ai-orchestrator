import { describe, expect, it } from "vitest";
import { maxSocketPathBytes } from "../../src/platform/host.js";
import { assertSocketPathFits } from "../../src/secrets/broker.js";

describe("the broker socket path limit on each host", () => {
  it("is 107 bytes on Linux and Windows and 103 on macOS", () => {
    expect(maxSocketPathBytes("linux")).toBe(107);
    expect(maxSocketPathBytes("win32")).toBe(107);
    expect(maxSocketPathBytes("darwin")).toBe(103);
  });

  it("refuses a 105-byte path on macOS only", () => {
    const p = `/${"a".repeat(104)}`;
    expect(() => assertSocketPathFits(p, "linux")).not.toThrow();
    expect(() => assertSocketPathFits(p, "darwin")).toThrow(/at most 103\. .* 2 bytes shorter/);
  });
});
