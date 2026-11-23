// Shared pieces of the build socket tests.
import http from "node:http";
import type { BuildPlanInput, BuildState } from "@aio/contracts";

/** A parsed answer: a build on success, an error otherwise. */
export interface SocketBody {
  build: BuildState;
  error: { code: string; message: string };
}

export const PLAN: BuildPlanInput = {
  title: "Add a total to the cart",
  criteria: [{ id: "AC1", text: "The cart reports the sum of its item prices." }],
  tasks: [
    {
      id: "T1",
      title: "Cart total",
      description: "Make total() return the sum of the item prices.",
      ownedFiles: ["src/cart.mjs"],
      criteria: ["AC1"],
    },
  ],
  commands: { test: [{ command: "node test/cart.test.mjs" }] },
};

/** Sends one request over the socket and returns its status and parsed body. */
export function send(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: SocketBody }> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path,
        agent: false,
        headers: data ? { "content-type": "application/json", ...headers } : headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body: (text ? JSON.parse(text) : null) as SocketBody,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}
