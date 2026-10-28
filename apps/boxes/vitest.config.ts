import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "boxes",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}", "electron/**/*.test.ts"],
    setupFiles: ["./test/setup.ts"],
    css: false,
  },
});
