// The remote terminal helpers of `aio box attach MACHINE/BOX`.
import { EventEmitter } from "node:events";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { TERMINAL_RESTORE, attachRemote, scanDetach, terminalUrl } from "../src/terminal.js";

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

describe("attachRemote", () => {
  const OUTPUT = Buffer.from("\x1b[?1049h\x1b[?1000h");
  const READY = JSON.stringify({ type: "ready", terminalId: "t1" });
  let wss: WebSocketServer | null = null;
  let tcp: Server | null = null;

  afterEach(async () => {
    for (const client of wss?.clients ?? []) client.terminate();
    await new Promise((resolve) => (wss ? wss.close(resolve) : resolve(null)));
    await new Promise((resolve) => (tcp ? tcp.close(resolve) : resolve(null)));
    wss = tcp = null;
  });

  function fakeTerminal(size: { columns?: number; rows?: number } = {}) {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: (_raw: boolean) => undefined,
    });
    const output = Object.assign(new EventEmitter(), {
      isTTY: true,
      ...size,
      screen: [] as Buffer[],
      write(data: Uint8Array | string) {
        output.screen.push(Buffer.from(data));
      },
    });
    return { input, output };
  }

  /** Starts a terminal server and attaches to it, with `serve` scripting each socket. */
  async function attach(
    terminal: ReturnType<typeof fakeTerminal>,
    serve: (ws: WebSocket, url: URL) => void,
    timings: { pingMs?: number; detachCloseMs?: number } = {},
  ) {
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => wss?.once("listening", resolve));
    const { port } = wss.address() as AddressInfo;
    wss.on("connection", (ws, req) => serve(ws, new URL(req.url ?? "", "http://127.0.0.1")));
    const notes: string[] = [];
    const done = attachRemote({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "token",
      machineId: "m1",
      boxId: "b1",
      kind: "session",
      io: terminal,
      note: (text) => notes.push(text),
      ...timings,
    });
    return { done, notes };
  }

  const screenText = (terminal: ReturnType<typeof fakeTerminal>) =>
    Buffer.concat(terminal.output.screen).toString();

  const pressDetach = async (terminal: ReturnType<typeof fakeTerminal>) => {
    for (let i = 0; i < 400 && terminal.output.screen.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    terminal.input.write(Buffer.from([0x1d, 0x1d]));
  };

  it("falls back to 80x24 when the terminal reports a zero size", async () => {
    const terminal = fakeTerminal({ columns: 0, rows: 0 });
    let query: URLSearchParams | null = null;
    const resizes: unknown[] = [];
    const { done } = await attach(terminal, (ws, url) => {
      query = url.searchParams;
      ws.on("message", (data) => {
        resizes.push(JSON.parse(data.toString()));
        ws.send(JSON.stringify({ type: "exit", exitCode: 0 }));
        ws.close(1000, "ended");
      });
      ws.send(READY);
      ws.send(OUTPUT, { binary: true });
    });
    for (let i = 0; i < 400 && terminal.output.screen.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    terminal.output.emit("resize");
    expect(await done).toBe(0);
    expect(query!.get("cols")).toBe("80");
    expect(query!.get("rows")).toBe("24");
    expect(resizes).toEqual([{ type: "resize", cols: 80, rows: 24 }]);
  });

  it("keeps the exit code after an error about one frame, and shows the error", async () => {
    const terminal = fakeTerminal();
    const { done, notes } = await attach(terminal, (ws) => {
      ws.send(READY);
      ws.send(
        JSON.stringify({
          type: "error",
          error: { code: "validation", message: "The frame is not a terminal control message." },
        }),
      );
      ws.send(JSON.stringify({ type: "exit", exitCode: 3 }));
      ws.close(1000, "ended");
    });
    expect(await done).toBe(3);
    expect(notes.join("")).toContain("The frame is not a terminal control message.");
  });

  it("keeps the detach result after an error about one frame", async () => {
    const terminal = fakeTerminal();
    const { done } = await attach(terminal, (ws) => {
      ws.send(READY);
      ws.send(
        JSON.stringify({ type: "error", error: { code: "validation", message: "Bad frame." } }),
      );
      ws.send(OUTPUT, { binary: true });
    });
    await pressDetach(terminal);
    expect(await done).toBe(0);
  });

  it("rejects with the server's error when it refuses the terminal before it is ready", async () => {
    const terminal = fakeTerminal();
    const { done } = await attach(terminal, (ws) => {
      ws.send(JSON.stringify({ type: "error", error: { code: "not_found", message: "No box." } }));
      ws.close(1008, "bad terminal request");
    });
    await expect(done).rejects.toThrow("No box.");
    expect(screenText(terminal)).toBe("");
  });

  it("restores the terminal before the detach note", async () => {
    const terminal = fakeTerminal();
    let screenAtNote = "";
    const { done, notes } = await attach(terminal, (ws) => {
      ws.send(READY);
      ws.send(OUTPUT, { binary: true });
    });
    const push = notes.push.bind(notes);
    notes.push = (...items) => {
      screenAtNote = screenText(terminal);
      return push(...items);
    };
    await pressDetach(terminal);
    expect(await done).toBe(0);
    expect(screenText(terminal)).toBe(OUTPUT.toString() + TERMINAL_RESTORE);
    expect(screenAtNote).toContain(TERMINAL_RESTORE);
  });

  it("restores the terminal after a dropped connection", async () => {
    const terminal = fakeTerminal();
    const { done } = await attach(terminal, (ws) => {
      ws.send(READY);
      ws.send(OUTPUT, { binary: true });
      setTimeout(() => ws.terminate(), 20);
    });
    await expect(done).rejects.toThrow("The terminal connection closed");
    expect(screenText(terminal)).toBe(OUTPUT.toString() + TERMINAL_RESTORE);
  });

  it("leaves the screen to tmux after an exit frame, and restores only a terminal", async () => {
    const terminal = fakeTerminal();
    const { done } = await attach(terminal, (ws) => {
      ws.send(READY);
      ws.send(OUTPUT, { binary: true });
      ws.send(JSON.stringify({ type: "exit", exitCode: 0 }));
      ws.close(1000, "ended");
    });
    expect(await done).toBe(0);
    expect(screenText(terminal)).toBe(OUTPUT.toString());

    await new Promise((resolve) => wss?.close(resolve));
    const piped = fakeTerminal();
    piped.output.isTTY = false;
    const second = await attach(piped, (ws) => {
      ws.send(READY);
      ws.send(OUTPUT, { binary: true });
      setTimeout(() => ws.terminate(), 20);
    });
    await expect(second.done).rejects.toThrow("The terminal connection closed");
    expect(screenText(piped)).toBe(OUTPUT.toString());
  });

  it("rejects and restores the terminal when the server stops answering pings", async () => {
    const terminal = fakeTerminal();
    const { done } = await attach(
      terminal,
      (ws) => {
        ws.send(READY);
        ws.send(OUTPUT, { binary: true });
        // A paused socket reads nothing, so it never answers a ping.
        setTimeout(() => ws.pause(), 5);
      },
      { pingMs: 40 },
    );
    await expect(done).rejects.toThrow("the server stopped answering pings");
    expect(screenText(terminal)).toBe(OUTPUT.toString() + TERMINAL_RESTORE);
  });

  it("keeps a connection whose server answers pings", async () => {
    const terminal = fakeTerminal();
    const { done } = await attach(
      terminal,
      (ws) => {
        ws.send(READY);
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "exit", exitCode: 4 }));
          ws.close(1000, "ended");
        }, 200);
      },
      { pingMs: 20 },
    );
    expect(await done).toBe(4);
  });

  it("detaches without waiting for a server that doesn't answer", async () => {
    const terminal = fakeTerminal();
    const { done } = await attach(
      terminal,
      (ws) => {
        ws.send(READY);
        ws.send(OUTPUT, { binary: true });
        setTimeout(() => ws.pause(), 5);
      },
      { detachCloseMs: 30 },
    );
    await pressDetach(terminal);
    expect(await done).toBe(0);
    expect(screenText(terminal)).toBe(OUTPUT.toString() + TERMINAL_RESTORE);
  });

  it("rejects when the opening handshake stalls", async () => {
    tcp = createServer(() => undefined);
    await new Promise<void>((resolve) => tcp?.listen(0, "127.0.0.1", resolve));
    const sockets = new Set<Socket>();
    tcp.on("connection", (socket) => sockets.add(socket));
    const { port } = tcp.address() as AddressInfo;
    await expect(
      attachRemote({
        baseUrl: `http://127.0.0.1:${port}`,
        token: "token",
        machineId: "m1",
        boxId: "b1",
        kind: "session",
        io: fakeTerminal(),
        note: () => undefined,
        handshakeMs: 30,
      }),
    ).rejects.toThrow("Opening handshake has timed out");
    for (const socket of sockets) socket.destroy();
  });
});
