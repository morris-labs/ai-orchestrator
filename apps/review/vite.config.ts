// Builds the renderer. The server serves it at `/review/`, so every asset URL
// is relative. In development, Vite forwards API and event calls to the local
// server on port 20400.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],
  // The app loads from loopback, so one bundle is fine.
  build: { outDir: "dist/renderer", emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:20400", ws: true, changeOrigin: false },
    },
  },
});
