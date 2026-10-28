// Playwright configuration for the Electron smoke test:
// `pnpm --filter @agentbox/review e2e`. Without a display, wrap it in
// `xvfb-run -a`; in a container without a setuid sandbox helper, also set
// ELECTRON_DISABLE_SANDBOX=1.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
});
