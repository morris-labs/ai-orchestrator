// Builds the renderer. The server serves `dist/renderer` at `/boxes/`, so
// every asset path is relative.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const SERVER = "https://127.0.0.1:21400";

/** The server's certificate, which the dev proxy trusts and nothing else. */
function serverCert(): string | undefined {
  const dataDir = process.env.AIO_DATA_DIR ?? join(homedir(), ".ai-orchestrator");
  try {
    return readFileSync(join(dataDir, "server.crt"), "utf8");
  } catch {
    return undefined;
  }
}

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
    // xterm.js and React make one ~750 kB chunk; the app loads from loopback.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    // `pnpm dev` forwards API calls to a running aio-server over HTTPS.
    proxy: {
      "/api": {
        target: { protocol: "https:", host: "127.0.0.1", port: 21400, ca: serverCert() },
        secure: true,
        ws: true,
        // The server takes WebSocket upgrades from its own origin only, so
        // an upgrade from this dev page carries the server's origin instead.
        configure: (proxy) =>
          proxy.on("proxyReqWs", (proxyReq, req) => {
            if (req.headers.origin === `http://${req.headers.host}`) {
              proxyReq.setHeader("origin", SERVER);
            }
          }),
      },
    },
  },
});
