import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "e2e",
    include: ["test/**/*.test.ts"],
    // The suite starts real processes and waits on them.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
