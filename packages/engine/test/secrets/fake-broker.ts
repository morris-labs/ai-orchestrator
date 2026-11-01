// A stand-in for the server's secrets broker on a Unix socket, for tests.
import http from "node:http";
import path from "node:path";
import { tempDir } from "../tmp.js";

export interface FakeBroker {
  socketPath: string;
  /** The parsed bodies of read requests. */
  reads: { names: string[]; caller?: string }[];
  listCalls: number;
  close(): Promise<void>;
}

/**
 * Serves `values` the way the broker does: `GET /v1/names` lists them, and
 * `POST /v1/read` answers all or nothing, with `not_found` for a missing
 * name. `fail` makes every route answer with that error instead.
 */
export async function startFakeBroker(
  values: Record<string, string>,
  fail?: { status: number; code: string; message: string },
): Promise<FakeBroker> {
  const socketPath = path.join(tempDir("aio-fake-broker-"), "broker.sock");
  const state: FakeBroker = {
    socketPath,
    reads: [],
    listCalls: 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (fail)
        return send(res, fail.status, { error: { code: fail.code, message: fail.message } });
      if (req.method === "GET" && req.url === "/v1/names") {
        state.listCalls += 1;
        return send(res, 200, { names: Object.keys(values).sort() });
      }
      if (req.method === "POST" && req.url === "/v1/read") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          names: string[];
          caller?: string;
        };
        state.reads.push(body);
        const missing = body.names.filter((n) => values[n] === undefined);
        if (missing.length > 0) {
          return send(res, 404, {
            error: { code: "not_found", message: `Not listed: ${missing.join(", ")}` },
          });
        }
        return send(res, 200, {
          values: Object.fromEntries(body.names.map((n) => [n, values[n]])),
        });
      }
      return send(res, 404, { error: { code: "not_found", message: "no route" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return state;
}
