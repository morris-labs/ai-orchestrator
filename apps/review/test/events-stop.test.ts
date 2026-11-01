// Stops an `EventsConnection` on Node's `ws`, as the Electron main process
// does on `before-quit`, while the upgrade is still in progress. `ws` emits
// `error` when a socket closes before it connects, and without a listener
// that error is uncaught and crashes the main process.
import { ApiClient, EventsConnection, type WebSocketCtor } from "@aio/ui/core";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

let server: Server | null = null;
const held: Socket[] = [];

/** Listens on a free port and accepts connections without ever answering the upgrade. */
async function silentServer(): Promise<number> {
  server = createServer((socket) => held.push(socket));
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No port.");
  return address.port;
}

afterEach(async () => {
  for (const s of held.splice(0)) s.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe("EventsConnection on Node's ws", () => {
  it("stops while the socket is connecting without an uncaught error", async () => {
    const port = await silentServer();
    const uncaught: unknown[] = [];
    const record = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", record);
    try {
      const conn = new EventsConnection({
        client: new ApiClient({
          baseUrl: `http://127.0.0.1:${port}`,
          WebSocket: WebSocket as unknown as WebSocketCtor,
          socketAuth: "header",
        }),
        onEvent: () => undefined,
        onResync: () => undefined,
      });
      conn.start();
      // Wait until the server has the connection, so the upgrade request is out.
      await expect.poll(() => held.length).toBe(1);
      expect(conn.currentStatus).toBe("connecting");
      conn.stop();
      // `ws` emits the error on the next tick; give it a few.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(uncaught).toEqual([]);
      expect(conn.currentStatus).toBe("closed");
    } finally {
      process.off("uncaughtException", record);
    }
  });
});
