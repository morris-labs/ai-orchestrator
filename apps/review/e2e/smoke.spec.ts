// Electron smoke test for the host peer. Build first (`pnpm --filter
// @agentbox/review build`) and fetch the Electron binary once
// (`pnpm --filter @agentbox/review e2e:setup`). The test starts a mock
// server, launches the app with a deep link, and checks the launcher,
// navigation, the token header, and the single-instance hand-off.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { PROJECT_ID, startMockServer } from "./mockServer.js";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const main = resolve(appDir, "dist/electron/main.js");

test("launches, prefills the launcher, and keeps a single instance", async () => {
  const mock = await startMockServer(resolve(appDir, "dist/renderer"));
  const env = {
    ...process.env,
    AGENTBOX_SERVER_URL: mock.url,
    AGENTBOX_SERVER_TOKEN: "smoke-token",
  } as Record<string, string>;
  const app = await electron.launch({ args: [main, `--project=${PROJECT_ID}`], env, cwd: appDir });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle("Agent Box Review");
    await expect(page.getByRole("heading", { name: "Start a review run" })).toBeVisible();
    await expect(page.getByLabel("Container")).toHaveValue(PROJECT_ID);
    expect(mock.requests.some((r) => r.includes("GET /api/v1/projects Bearer smoke-token"))).toBe(
      true,
    );

    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page.getByRole("heading", { name: "Infrastructure" })).toBeVisible();
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByText("Automatic model selection")).toBeVisible();

    // A second launch hands its deep link to the first window and exits.
    const second = spawnSync(
      String(app.process().spawnfile),
      [main, "agentbox-review://launch?project=other"],
      {
        env,
        cwd: appDir,
        timeout: 20_000,
      },
    );
    expect(second.status).toBe(0);
    await expect(page).toHaveURL(/#\/launch\?project=other/);
    expect(app.windows()).toHaveLength(1);
  } finally {
    await app.evaluate(({ app: a }) => a.quit());
    await app.close().catch(() => undefined);
    mock.server.close();
  }
});
