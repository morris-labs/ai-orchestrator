// Builds the renderer. The server serves `dist/renderer` at `/boxes/`, so
// every asset path is relative.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
    // `pnpm dev` forwards API calls to a running agentbox-server.
    proxy: {
      "/api": { target: "http://127.0.0.1:20400", ws: true },
    },
  },
});
