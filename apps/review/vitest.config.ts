import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  test: {
    name: "review",
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}", "electron/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
