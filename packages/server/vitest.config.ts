import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "server",
    setupFiles: ["./test/setup-tmp.ts"],
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
  },
});
