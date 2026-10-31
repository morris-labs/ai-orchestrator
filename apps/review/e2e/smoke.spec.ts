// Electron smoke test. Build first (`pnpm --filter @agentbox/review build`)
// and fetch the Electron binary once (`pnpm --filter @agentbox/review
// e2e:setup`). The test serves the built renderer and the shared fake server
// from `@agentbox/ui/testing` over HTTPS, launches the app with a deep link,
// and checks the launcher, navigation, the token hand-off, and the
// single-instance hand-off. Without a display, run it under `xvfb-run`.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { createServerIdentity } from "@agentbox/contracts/tls";
import { DEMO_PROJECT as PROJECT_ID, FakeServer, makeProject } from "@agentbox/ui/testing";
import { describeExit, secondInstanceCommand, serveFake } from "@agentbox/ui/testing/node";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const main = resolve(appDir, "dist/electron/main.cjs");
/** Where the fake server's `/review/away` redirects to. */
const AWAY = "http://127.0.0.1:9/redirected";

test("launches, prefills the launcher, and keeps a single instance", async () => {
  const fake = new FakeServer({
    projects: [makeProject({ root: "/home/user/src/example-app", id: PROJECT_ID })],
  });
  // The app pins the certificate in the data directory, as with the real server.
  const identity = createServerIdentity();
  const dataDir = mkdtempSync(join(tmpdir(), "agentbox-e2e-"));
  writeFileSync(join(dataDir, "server.crt"), identity.cert);
  const mock = await serveFake(fake, {
    static: { "/review/": resolve(appDir, "dist/renderer") },
    redirects: { "/review/away": AWAY },
    tls: identity,
  });
  const env = {
    ...process.env,
    AGENTBOX_SERVER_URL: mock.url,
    AGENTBOX_DATA_DIR: dataDir,
    AGENTBOX_SERVER_TOKEN: "smoke-token",
  } as Record<string, string>;
  const app = await electron.launch({ args: [main, `--project=${PROJECT_ID}`], env, cwd: appDir });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle("Agent Box Review");
    await expect(page.getByRole("heading", { name: "Start a review run" })).toBeVisible();
    await expect(page.getByLabel("Container")).toHaveValue(PROJECT_ID);
    // The page trades the token for the cookie and keeps none on its bridge.
    expect(
      mock.requests.some((r) => r.includes("POST /api/v1/auth/session Bearer smoke-token")),
    ).toBe(true);
    expect(
      await page.evaluate(() => {
        const b = (window as unknown as { agentbox: { takeToken(): string | null } }).agentbox;
        return { onBridge: "token" in b, again: b.takeToken() };
      }),
    ).toEqual({ onBridge: false, again: null });

    await page.getByRole("link", { name: "Dashboard" }).click();
    await expect(page.getByRole("heading", { name: "Infrastructure" })).toBeVisible();
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByRole("group", { name: "Copilot defaults" })).toBeVisible();

    // A second launch hands its deep link to the first window and exits. It
    // gets the switches Playwright gave the first; see `secondInstanceCommand`.
    const command = secondInstanceCommand([main, "agentbox-review://launch?project=other"], env);
    const second = spawnSync(String(app.process().spawnfile), command.args, {
      env: command.env,
      cwd: appDir,
      timeout: 20_000,
    });
    expect(second.status, describeExit(second)).toBe(0);
    await expect(page).toHaveURL(/#\/launch\?project=other/);
    expect(app.windows()).toHaveLength(1);

    // Only http and https links open outside the app.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { opened?: string[] }).opened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    await page.evaluate(() => {
      window.open("file:///tmp/x.desktop");
      window.open("smb://example.com/share");
      window.open("https://example.com/pull/1");
    });
    await expect
      .poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened))
      .toEqual(["https://example.com/pull/1"]);

    // Navigating away leaves the window on the app's page: to another
    // origin, to the server's own origin outside /review/, or through a
    // redirect from inside /review/. The listeners added here run after the
    // app's own handlers, so they see whether those blocked each attempt.
    await app.evaluate(({ BrowserWindow }) => {
      const seen: string[] = [];
      (globalThis as { seen?: string[] }).seen = seen;
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      contents.on("will-navigate", (e) => {
        seen.push(`navigate ${e.url} ${e.defaultPrevented ? "blocked" : "allowed"}`);
      });
      contents.on("will-redirect", (e) => {
        seen.push(`redirect ${e.url} ${e.defaultPrevented ? "blocked" : "allowed"}`);
      });
    });
    const before = page.url();
    const attempts: [string, string[]][] = [
      ["http://127.0.0.1:9/elsewhere", ["navigate http://127.0.0.1:9/elsewhere blocked"]],
      [`${mock.url}/boxes/`, [`navigate ${mock.url}/boxes/ blocked`]],
      [
        `${mock.url}/review/away`,
        [`navigate ${mock.url}/review/away allowed`, `redirect ${AWAY} blocked`],
      ],
    ];
    for (const [url, want] of attempts) {
      await app.evaluate(() => (globalThis as { seen?: string[] }).seen?.splice(0));
      await page.evaluate((u) => {
        window.location.href = u;
      }, url);
      await expect
        .poll(() => app.evaluate(() => (globalThis as { seen?: string[] }).seen))
        .toEqual(want);
      expect(page.url()).toBe(before);
    }
  } finally {
    await app.evaluate(({ app: a }) => a.quit());
    await app.close().catch(() => undefined);
    await mock.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
