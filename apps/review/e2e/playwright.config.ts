// Playwright configuration for the Electron smoke test. It runs on the host
// peer, which has a display: `pnpm --filter @agentbox/review e2e`.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
});
