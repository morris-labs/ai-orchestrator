// How an Electron main process trusts the server: it pins the certificate
// in the server's data directory for its own REST calls and WebSockets, and
// for the pages its windows load from the server. Node.js only: import it as
// `@aio/ui/electron-main`, never from page code.
import {
  matchesPin,
  pinnedFetch,
  pinnedTlsOptions,
  readServerPin,
  type ServerPin,
} from "@aio/contracts/tls";
import type { WebSocketCtor } from "../api/client";

export { dataFile, serverUrl } from "./server-config";
export * from "./connection";

/**
 * Returns a function that reads the certificate in `certFile` each time it
 * runs, so a certificate the server replaced is picked up. The function
 * throws when the server has never created the file.
 */
export function pinReader(certFile: string): () => ServerPin {
  return () => {
    const pin = readServerPin(certFile);
    if (!pin) {
      throw new Error(
        `No server certificate at ${certFile}. The server creates it on its first start.`,
      );
    }
    return pin;
  };
}

/** A `WebSocket` constructor such as the `ws` package's, which takes TLS options. */
export type NodeWebSocketCtor = new (url: string, options: never) => unknown;

/**
 * Wraps a Node.js `WebSocket` constructor so every socket trusts the pinned
 * certificate only. A socket to a server that presents another certificate
 * fails its handshake before the upgrade, and its `Authorization` header,
 * leaves.
 */
export function pinnedWebSocket(Base: NodeWebSocketCtor, pin: () => ServerPin): WebSocketCtor {
  // Called with `new`; returning an object from a constructor returns that object.
  function Pinned(url: string, options?: object) {
    return new Base(url, { ...options, ...pinnedTlsOptions(pin()) } as never);
  }
  return Pinned as unknown as WebSocketCtor;
}

/** The `fetch` and `WebSocket` an `ApiClient` in a main process uses. */
export function pinnedTransport(
  Base: NodeWebSocketCtor,
  pin: () => ServerPin,
): { fetch: typeof fetch; WebSocket: WebSocketCtor } {
  return { fetch: pinnedFetch(pin), WebSocket: pinnedWebSocket(Base, pin) };
}

/**
 * The result a `session.setCertificateVerifyProc` callback gives Chromium for
 * a certificate: 0 accepts it, -2 refuses it, and -3 leaves the decision to
 * Chromium's own check. For the server's host, only the pinned certificate
 * passes; every other host gets Chromium's check.
 *
 * Chromium reports no port, so the pin covers every port of the server's
 * host. The apps load nothing else from loopback over HTTPS.
 */
export function certificateVerdict(
  request: { hostname: string; certificate: { data: string } },
  serverUrl: string,
  pin: () => ServerPin,
): 0 | -2 | -3 {
  const bare = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare(request.hostname) !== bare(new URL(serverUrl).hostname)) return -3;
  try {
    return matchesPin(request.certificate.data, pin()) ? 0 : -2;
  } catch {
    return -2;
  }
}
