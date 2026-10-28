import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "engine",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
