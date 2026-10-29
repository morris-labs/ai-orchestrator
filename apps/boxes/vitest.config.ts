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
    // The jsdom screen tests take over 5 seconds under heavy parallel load. A
    // test that hits the default 5-second timeout keeps running after cleanup
    // and types into the next test's inputs, so the timeout also caused
    // unrelated assertion failures.
    testTimeout: 20000,
  },
});
