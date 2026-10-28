// A small WebSocket client for the tests: collects frames and waits for them.
import WebSocket from "ws";

export interface TestSocket {
  ws: WebSocket;
  texts: unknown[];
  binary: Buffer[];
  closed: Promise<{ code: number; reason: string }>;
  /** Waits until `predicate` holds for the collected frames. */
  until(predicate: (s: TestSocket) => boolean, timeoutMs?: number): Promise<void>;
}

export async function connect(
  url: string,
  headers: Record<string, string> = {},
): Promise<TestSocket> {
  const ws = new WebSocket(url, { headers });
  const socket: TestSocket = {
    ws,
    texts: [],
    binary: [],
    closed: new Promise((resolve) =>
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
    ),
    async until(predicate, timeoutMs = 2000) {
      const start = Date.now();
      while (!predicate(socket)) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(`Timed out; frames: ${JSON.stringify(socket.texts)}`);
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
  ws.on("message", (data, isBinary) => {
    if (isBinary) socket.binary.push(Buffer.from(data as Buffer));
    else socket.texts.push(JSON.parse(data.toString()));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (req, res) => {
      req.destroy();
      reject(new Error(`HTTP ${res.statusCode}`));
    });
  });
  return socket;
}
