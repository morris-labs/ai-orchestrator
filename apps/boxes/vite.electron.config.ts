// Builds the Electron main process and preload script as CommonJS, so they
// can import the dependency-free parts of `@agentbox/ui`.
//
// Each entry is its own build: `vite build --mode main`, then
// `--mode preload`. Built together, the two entries share a chunk (at least
// the bundler's runtime helpers), and the preload starts with
// `require("./main.cjs")`. A sandboxed preload can require only a few
// built-in modules, so that line fails and the page gets no bridge.
// `test/electron-build.test.ts` checks the built preload.
import { builtinModules } from "node:module";
import { defineConfig } from "vite";

const ENTRIES: Record<string, string> = {
  main: "electron/main.ts",
  preload: "electron/preload.ts",
};

export default defineConfig(({ mode }) => {
  const entry = ENTRIES[mode];
  if (!entry) throw new Error(`Build with --mode main or --mode preload, not --mode ${mode}.`);
  return {
    build: {
      outDir: "dist/electron",
      // The main build runs first and clears the directory; the preload build adds to it.
      emptyOutDir: mode === "main",
      ssr: true,
      target: "node22",
      sourcemap: true,
      rollupOptions: {
        input: { [mode]: entry },
        external: ["electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
    ssr: { noExternal: true },
  };
});
