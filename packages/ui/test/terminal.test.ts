import { describe, expect, it, vi } from "vitest";
import { ApiClient, openTerminalSocket, TerminalConnection } from "../src/core";
import { classifyTerminalKey, endedBanner, handleTerminalKey } from "../src/terminal/keys";
import { FakeServer, FakeSocket } from "../src/testing";

const key = (
  k: string,
  code: string,
  mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {},
) => ({
  key: k,
  code,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe("openTerminalSocket", () => {
  const server = new FakeServer();
  const client = new ApiClient({ baseUrl: "http://h", token: "t", WebSocket: server.WebSocket });
  it("opens a session terminal with its size", () => {
    const s = openTerminalSocket(
      client,
      { kind: "session", boxId: "b" },
      { cols: 100, rows: 30 },
    ) as unknown as FakeSocket;
    expect(s.path).toBe("/api/v1/terminals");
    expect(Object.fromEntries(s.query)).toEqual({
      kind: "session",
      boxId: "b",
      cols: "100",
      rows: "30",
      token: "t",
    });
  });
  it("opens side, shell, and job streams", () => {
    const side = openTerminalSocket(
      client,
      { kind: "side", boxId: "b", platform: "codex" },
      { cols: 1, rows: 1 },
    ) as unknown as FakeSocket;
    expect(side.query.get("platform")).toBe("codex");
    const shell = openTerminalSocket(
      client,
      { kind: "shell", projectId: "p" },
      { cols: 1, rows: 1 },
    ) as unknown as FakeSocket;
    expect(shell.query.get("projectId")).toBe("p");
    const job = openTerminalSocket(
      client,
      { kind: "job", jobId: "j1" },
      { cols: 1, rows: 1 },
    ) as unknown as FakeSocket;
    expect(job.path).toBe("/api/v1/jobs/j1/stream");
  });
});

describe("TerminalConnection", () => {
  function setup() {
    const sock = new FakeSocket("ws://h/api/v1/terminals", false);
    const handlers = { onData: vi.fn(), onExit: vi.fn(), onReady: vi.fn(), onError: vi.fn() };
    const conn = new TerminalConnection(sock as unknown as WebSocket, handlers);
    sock.serverOpen();
    return { sock, conn, handlers };
  }

  it("passes binary frames through and sends input as binary", () => {
    const { sock, conn, handlers } = setup();
    sock.serverSend(new Uint8Array([104, 105]));
    expect(Array.from(handlers.onData.mock.calls[0]?.[0] as Uint8Array)).toEqual([104, 105]);
    conn.write("ls\r");
    expect(sock.sent[0]).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(sock.sent[0] as Uint8Array)).toBe("ls\r");
    expect(sock.binaryType).toBe("arraybuffer");
  });

  it("sends binary input one byte per character", () => {
    const { sock, conn } = setup();
    conn.writeBinary("\x1b[M\x20\xa0\x21");
    expect(Array.from(sock.sent[0] as Uint8Array)).toEqual([0x1b, 0x5b, 0x4d, 0x20, 0xa0, 0x21]);
  });

  it("sends resize as JSON and reports ready, error, and exit", () => {
    const { sock, conn, handlers } = setup();
    conn.resize(120, 40);
    expect(sock.sentJson).toEqual([{ type: "resize", cols: 120, rows: 40 }]);
    sock.serverSend({ type: "ready", terminalId: "t1" });
    sock.serverSend({ type: "error", error: { code: "not_found", message: "gone" } });
    sock.serverSend({ type: "exit", exitCode: 3 });
    sock.serverClose();
    expect(handlers.onReady).toHaveBeenCalledWith("t1");
    expect(handlers.onError).toHaveBeenCalled();
    expect(handlers.onExit).toHaveBeenCalledTimes(1);
    expect(handlers.onExit).toHaveBeenCalledWith(3);
    conn.write("x");
    expect(sock.sent).toHaveLength(1);
  });

  it("treats a dropped socket as an ended session with no code", () => {
    const { sock, handlers, conn } = setup();
    sock.serverClose();
    expect(handlers.onExit).toHaveBeenCalledWith(null);
    expect(conn.isEnded).toBe(true);
  });
});

describe("terminal keys", () => {
  it("copies and pastes with Ctrl+Shift+C and V", () => {
    expect(classifyTerminalKey(key("C", "KeyC", { ctrlKey: true, shiftKey: true }))).toBe("copy");
    expect(classifyTerminalKey(key("V", "KeyV", { ctrlKey: true, shiftKey: true }))).toBe("paste");
  });
  it("leaves application chords to the window and the rest to the terminal", () => {
    expect(classifyTerminalKey(key("N", "KeyN", { ctrlKey: true, shiftKey: true }))).toBe(
      "application",
    );
    expect(classifyTerminalKey(key("2", "Digit2", { altKey: true }))).toBe("application");
    expect(classifyTerminalKey(key("F5", "F5"))).toBe("application");
    expect(classifyTerminalKey(key("c", "KeyC", { ctrlKey: true }))).toBe("terminal");
    expect(classifyTerminalKey(key("n", "KeyN", { ctrlKey: true }))).toBe("terminal");
    expect(classifyTerminalKey(key("0", "Digit0", { altKey: true }))).toBe("terminal");
  });
  it("cancels the browser's own copy and paste so that a paste arrives once", () => {
    const run = (k: ReturnType<typeof key>) => {
      const e = { ...k, type: "keydown", preventDefault: vi.fn() };
      const actions = { copy: vi.fn(), paste: vi.fn() };
      return { result: handleTerminalKey(e, actions), e, actions };
    };
    const paste = run(key("V", "KeyV", { ctrlKey: true, shiftKey: true }));
    expect(paste.result).toBe(false);
    expect(paste.e.preventDefault).toHaveBeenCalled();
    expect(paste.actions.paste).toHaveBeenCalledTimes(1);
    const copy = run(key("C", "KeyC", { ctrlKey: true, shiftKey: true }));
    expect(copy.e.preventDefault).toHaveBeenCalled();
    expect(copy.actions.copy).toHaveBeenCalledTimes(1);
    const plain = run(key("c", "KeyC", { ctrlKey: true }));
    expect(plain.result).toBe(true);
    expect(plain.e.preventDefault).not.toHaveBeenCalled();
  });
  it("words the ended banner as the Qt widget did", () => {
    expect(endedBanner(2)).toBe("Session ended (exit 2).\nThis box is no longer attached.");
    expect(endedBanner(null)).toBe("Session ended.\nThis box is no longer attached.");
  });
});
