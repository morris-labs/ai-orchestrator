// The remote terminal helpers of `aio box attach MACHINE/BOX`.
import { describe, expect, it } from "vitest";
import { scanDetach, terminalUrl } from "../src/terminal.js";

describe("scanDetach", () => {
  it("detaches on Ctrl+] twice, in one chunk or across two", () => {
    expect(scanDetach(Buffer.from([0x61, 0x1d, 0x1d, 0x62]), false)).toEqual({
      send: Buffer.from([0x61]),
      detach: true,
      pending: false,
    });
    const first = scanDetach(Buffer.from([0x61, 0x1d]), false);
    expect(first).toEqual({ send: Buffer.from([0x61]), detach: false, pending: true });
    expect(scanDetach(Buffer.from([0x1d]), first.pending)).toMatchObject({ detach: true });
  });

  it("passes a lone Ctrl+] through with the key after it", () => {
    expect(scanDetach(Buffer.from([0x1d]), false)).toEqual({
      send: Buffer.alloc(0),
      detach: false,
      pending: true,
    });
    expect(scanDetach(Buffer.from([0x63]), true)).toEqual({
      send: Buffer.from([0x1d, 0x63]),
      detach: false,
      pending: false,
    });
  });
});

describe("terminalUrl", () => {
  it("sends the terminal through the machine proxy prefix", () => {
    expect(terminalUrl("https://127.0.0.1:21400/", "m 1", { kind: "session", cols: 80 })).toBe(
      "wss://127.0.0.1:21400/api/v1/machines/m%201/proxy/terminals?kind=session&cols=80",
    );
    expect(terminalUrl("http://127.0.0.1:21400", "local", { kind: "shell" })).toBe(
      "ws://127.0.0.1:21400/api/v1/terminals?kind=shell",
    );
  });
});
