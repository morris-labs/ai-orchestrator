// Builds the renderer. The server serves it at `/review/`, so every asset URL
// is relative. In development, Vite forwards API and event calls to the local
// server on port 21400 over HTTPS.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The built page's Content-Security-Policy. The page holds the server token
 * for a moment and shows text from models and pull requests, so scripts load
 * only from the page's own origin, and requests (WebSockets included) go
 * only there. Styles allow inline `style` attributes and elements, which
 * React and the shared theme use. The dev server doesn't get it: its React
 * refresh preamble is an inline script.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "agentbox-csp",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
        injectTo: "head-prepend",
      },
    ],
  };
}

const SERVER = "https://127.0.0.1:21400";

/** The server's certificate, which the dev proxy trusts and nothing else. */
function serverCert(): string | undefined {
  const dataDir = process.env.AGENTBOX_DATA_DIR ?? join(homedir(), ".claude-box");
  try {
    return readFileSync(join(dataDir, "server.crt"), "utf8");
  } catch {
    return undefined;
  }
}

export default defineConfig({
  base: "./",
  plugins: [react(), contentSecurityPolicy()],
  // The app loads from loopback, so one bundle is fine.
  build: { outDir: "dist/renderer", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    proxy: {
      "/api": {
        target: { protocol: "https:", host: "127.0.0.1", port: 21400, ca: serverCert() },
        secure: true,
        ws: true,
        changeOrigin: false,
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
