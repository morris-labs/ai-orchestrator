// A small HTTP server for the smoke test: it serves the built renderer at
// `/review/` and answers the routes the first screens call, so the test
// needs no real agentbox-server.
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { defaultConfig } from "@agentbox/contracts";

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

export const PROJECT_ID = "example-app-1a2b3c4d";

const project = {
  project: {
    id: PROJECT_ID,
    root: "/home/user/src/example-app",
    name: "example-app",
    primaryRepo: "/home/user/src/example-app",
    tcpMaps: [],
    mounts: [],
    secretRefs: [],
    policyPath: ".claude-box/policy.yaml",
    createdAt: "2026-10-28T09:00:00.000Z",
    updatedAt: "2026-10-28T09:00:00.000Z",
  },
  running: 0,
  total: 0,
  container: null,
};

const ROUTES: Record<string, unknown> = {
  "GET /api/v1/projects": { projects: [project] },
  "GET /api/v1/runs": { runs: [] },
  "GET /api/v1/settings": defaultConfig(),
  "GET /api/v1/usage": { vendors: [] },
  "GET /api/v1/usage/samples": { samples: [] },
  "GET /api/v1/notifications": { notifications: [] },
  "POST /api/v1/stats/refresh": { ok: true },
};

export async function startMockServer(
  rendererDir: string,
): Promise<{ url: string; server: Server; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push(`${req.method} ${url.pathname} ${req.headers.authorization ?? ""}`);
    const route = ROUTES[`${req.method} ${url.pathname}`];
    if (route !== undefined) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(route));
      return;
    }
    if (url.pathname.startsWith("/review/")) {
      const rel = normalize(url.pathname.slice("/review/".length) || "index.html");
      if (rel.startsWith("..")) {
        res.writeHead(400).end();
        return;
      }
      readFile(join(rendererDir, rel)).then(
        (body) => {
          res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream" });
          res.end(body);
        },
        () => res.writeHead(404).end(),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { code: "not_found", message: "No such route in the smoke server." },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The smoke server has no port.");
  return { url: `http://127.0.0.1:${address.port}`, server, requests };
}
