import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ExecBackend, ExecRequest } from "../../src/terminals/exec.js";
import {
  OUTPUT_HIGH_WATER,
  OUTPUT_LOW_WATER,
  serveTerminal,
} from "../../src/terminals/terminal-socket.js";

/** A socket double whose send buffer the test sets by hand. */
class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly callbacks: (() => void)[] = [];
  send(_data: unknown, opts?: unknown, cb?: () => void): void {
    const done = typeof opts === "function" ? (opts as () => void) : cb;
    if (done) this.callbacks.push(done);
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
}

const tick = () => new Promise((r) => setImmediate(r));

describe("terminal output backpressure", () => {
  it("pauses the exec while the socket is backed up and resumes once it drains", async () => {
    const stream = new PassThrough();
    const backend = {
      start: async () => ({
        stream,
        resize: async () => undefined,
        exitCode: async () => 0,
        close: () => stream.destroy(),
      }),
    } as unknown as ExecBackend;
    const ws = new FakeSocket();
    const served = serveTerminal(ws as unknown as WebSocket, backend, {} as ExecRequest);
    await tick();

    stream.write("small");
    await tick();
    expect(stream.isPaused()).toBe(false);

    ws.bufferedAmount = OUTPUT_HIGH_WATER + 1;
    stream.write("big");
    await tick();
    expect(stream.isPaused()).toBe(true);

    // A send completes, but the buffer is still above the low-water mark.
    ws.bufferedAmount = OUTPUT_LOW_WATER + 1;
    ws.callbacks.shift()!();
    expect(stream.isPaused()).toBe(true);

    ws.bufferedAmount = 0;
    for (const cb of ws.callbacks.splice(0)) cb();
    expect(stream.isPaused()).toBe(false);

    ws.close();
    await served;
  });
});
