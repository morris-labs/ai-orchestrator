// Playwright configuration for the Electron smoke test. Run it on a host
// with a display and a running agentbox-server:
//
//   corepack pnpm --filter @agentbox/boxes build
//   corepack pnpm --filter @agentbox/boxes e2e
//
// Set AGENTBOX_E2E_BOX to the id of a running box to also type into its
// terminal and check the echo.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  outputDir: "../test-results",
});
