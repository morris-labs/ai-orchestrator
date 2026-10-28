// Builds the Electron main process and preload script as CommonJS, so they
// can import the dependency-free parts of `@agentbox/ui`.
import { builtinModules } from "node:module";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/electron",
    emptyOutDir: true,
    ssr: true,
    target: "node22",
    sourcemap: true,
    rollupOptions: {
      input: { main: "electron/main.ts", preload: "electron/preload.ts" },
      external: ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { format: "cjs", entryFileNames: "[name].cjs" },
    },
  },
  ssr: { noExternal: true },
});
