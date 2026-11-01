// An in-process WebSocket upgrade into this server's own routes, for the
// streams that arrive over a link.
//
// `@fastify/websocket` has `injectWS`, but a route that sends a frame as
// soon as it opens, such as `terminals.open` with its `ready` frame or
// `jobs.stream` with its backlog, can lose that frame: `injectWS` drops the
// bytes that arrive in the same chunk as the `101 Switching Protocols`
// response, and the client socket parses frames before the caller of the
// returned promise can listen for them. This version reads the whole
// handshake response, hands what follows it to the client socket, and
// returns that socket paused, so the caller attaches its listeners first.
import { randomBytes } from "node:crypto";
import { Duplex, PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";

/** The most bytes a handshake response may have before the upgrade fails. */
const MAX_HANDSHAKE_BYTES = 64 * 1024;

/** What `ws` exposes to put a client socket on an already upgraded stream. */
interface SettableSocket {
  _isServer: boolean;
  setSocket(socket: Duplex, head: Buffer, options: { maxPayload: number }): void;
}

/**
 * Opens a WebSocket to `url` on `api` without a network connection, and
 * resolves with the client end once the upgrade completes. The client end
 * starts paused: call its `resume()` once its listeners are in place, or no
 * frame arrives. Rejects with
 * `Unexpected server response: STATUS` when the route answers with
 * anything but `101`.
 */
export function injectWebSocket(
  api: FastifyInstance,
  url: string,
  headers: Record<string, string>,
): Promise<WebSocket> {
  const toClient = new PassThrough();
  const toServer = new PassThrough();
  const serverSide = Duplex.from({ readable: toServer, writable: toClient });
  const clientSide = Duplex.from({ readable: toClient, writable: toServer });
  // The constructor with no address makes a socket that waits for `setSocket`.
  const ws = new WebSocket(null as unknown as string, undefined, {
    isServer: false,
  } as WebSocket.ClientOptions);

  return new Promise<WebSocket>((resolve, reject) => {
    let received = Buffer.alloc(0);
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clientSide.off("data", onData);
      clientSide.destroy();
      serverSide.destroy();
      reject(err);
    };
    const onEnd = () => fail(new Error("The server closed the stream during the upgrade."));
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf("\r\n\r\n");
      if (end < 0) {
        if (received.length > MAX_HANDSHAKE_BYTES)
          fail(new Error("The upgrade response is too long."));
        return;
      }
      clientSide.pause();
      clientSide.off("data", onData);
      clientSide.off("end", onEnd);
      clientSide.off("close", onEnd);
      const head = received.subarray(0, end).toString("latin1");
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
      if (status !== 101) {
        fail(new Error(`Unexpected server response: ${status}`));
        return;
      }
      settled = true;
      ws.once("open", () => resolve(ws));
      const socket = ws as unknown as SettableSocket;
      socket._isServer = false;
      socket.setSocket(clientSide, received.subarray(end + 4), { maxPayload: 0 });
      // `clientSide` is still paused; this records the pause on `ws` too.
      ws.pause();
    };
    clientSide.on("data", onData);
    clientSide.once("end", onEnd);
    clientSide.once("close", onEnd);
    clientSide.on("error", (err) => fail(err));

    const req = {
      method: "GET",
      url,
      httpVersion: "1.1",
      headers: {
        ...headers,
        connection: "upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
      },
    };
    api.server.emit("upgrade", req, serverSide, Buffer.alloc(0));
  });
}
