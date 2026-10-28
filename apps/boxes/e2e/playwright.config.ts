// Playwright configuration for the Electron smoke test:
//
//   corepack pnpm --filter @agentbox/boxes build
//   corepack pnpm --filter @agentbox/boxes e2e
//
// Without AGENTBOX_SERVER_URL the test serves the shared fake server; set it
// to run against a real agentbox-server on a host. Set AGENTBOX_E2E_BOX to
// the id of a running box to also type into its terminal and check the echo.
// Without a display, wrap the command in `xvfb-run -a`; in a container
// without a setuid sandbox helper, also set ELECTRON_DISABLE_SANDBOX=1.
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
