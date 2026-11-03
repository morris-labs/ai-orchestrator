// The in-process WebSocket upgrade that serves link streams.
import fastifyWebsocket from "@fastify/websocket";
import type { Duplex } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { injectWebSocket } from "../../src/hub/inject.js";
import { waitFor } from "../events/fake-engine.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function server(): Promise<FastifyInstance> {
  app = Fastify();
  await app.register(fastifyWebsocket);
  app.get("/early", { websocket: true }, (socket) => {
    // Sent in the same tick as the upgrade response.
    socket.send("ready");
    socket.send(Buffer.from([0xff, 0x00]), { binary: true });
    socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
  });
  app.get(
    "/guarded",
    { websocket: true, preHandler: async (_req, reply) => reply.code(403).send() },
    () => undefined,
  );
  await app.ready();
  return app;
}

describe("injectWebSocket", () => {
  it("delivers the frames a route sends as it opens, once the caller resumes", async () => {
    const api = await server();
    const ws = await injectWebSocket(api, "/early", {});
    const got: [string, boolean][] = [];
    ws.on("message", (data, isBinary) =>
      got.push([isBinary ? `bin:${[...(data as Buffer)].join(",")}` : data.toString(), isBinary]),
    );
    // Nothing is lost while the socket waits paused.
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([]);
    ws.resume();
    ws.send("hi");
    await waitFor(() => got.length === 3);
    expect(got).toEqual([
      ["ready", false],
      ["bin:255,0", true],
      ["echo:hi", false],
    ]);
    ws.close();
  });

  it("rejects with the status of a refused upgrade", async () => {
    const api = await server();
    await expect(injectWebSocket(api, "/guarded", {})).rejects.toThrow(
      "Unexpected server response: 403",
    );
    await expect(injectWebSocket(api, "/nowhere", {})).rejects.toThrow(
      "Unexpected server response: 404",
    );
  });

  it("guards the server stream when the upgrade handler adds no error listener", async () => {
    // A bare handler, like `@fastify/websocket` before 11.3, refuses the upgrade.
    const api = Fastify();
    let listeners = -1;
    let closed: Promise<void> = Promise.resolve();
    api.server.on("upgrade", (_req, socket: Duplex) => {
      closed = new Promise((resolve) => socket.once("close", () => resolve()));
      listeners = socket.listenerCount("error");
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await expect(injectWebSocket(api, "/guarded", {})).rejects.toThrow(
      "Unexpected server response: 403",
    );
    await closed;
    // Without a listener, the `AbortError` from the destroy is an uncaught exception.
    expect(listeners).toBeGreaterThan(0);
  });
});
