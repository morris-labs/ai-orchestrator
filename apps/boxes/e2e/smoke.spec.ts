// A smoke test of the packaged boxes app: the window opens on the server's
// page, the menus and chords work, and, when AGENTBOX_E2E_BOX names a running
// box, its terminal echoes what you type. With AGENTBOX_SERVER_URL set, it
// runs against that server (a real host); without it, against the shared
// fake server from `@agentbox/ui/testing`, which serves the built renderer
// at /boxes/ over HTTPS with a certificate in a temporary data directory.
// Without a display, run it under `xvfb-run`.
//
// The app starts with a temporary `--user-data-dir`, so it neither reads nor
// writes the saved settings (project selection, split sizes) of the Agent
// Box that you use, and it doesn't collide with that app's single-instance
// lock. The terminal test also selects "All projects" itself.
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { FakeServer, makeBoxView } from "@agentbox/ui/testing";
import {
  describeExit,
  secondInstanceCommand,
  serveFake,
  type ServedFake,
} from "@agentbox/ui/testing/node";
import { spawnSync } from "node:child_process";
import { createServerIdentity } from "@agentbox/contracts/tls";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const appDir = resolve(import.meta.dirname, "..");
const mainFile = resolve(appDir, "dist/electron/main.cjs");

let app: ElectronApplication;
let page: Page;
let fake: ServedFake | null = null;
let dataDir: string | null = null;
let userDataDir: string | null = null;
let appArgs: string[] = [];
const env: Record<string, string> = { ...(process.env as Record<string, string>) };

test.beforeAll(async () => {
  if (!existsSync(mainFile)) throw new Error(`Build the app first: ${mainFile} is missing.`);
  if (!process.env.AGENTBOX_SERVER_URL) {
    const server = new FakeServer({
      boxes: [
        makeBoxView({
          box: { id: "claude-agent-site", targetDir: "/w/site", conversationName: "Site work" },
          status: "running",
        }),
        makeBoxView({ box: { id: "claude-agent-api", targetDir: "/w/api" } }),
      ],
    });
    // The app pins the certificate in the data directory, as with the real server.
    const identity = createServerIdentity();
    dataDir = mkdtempSync(join(tmpdir(), "agentbox-e2e-"));
    writeFileSync(join(dataDir, "server.crt"), identity.cert);
    fake = await serveFake(server, {
      static: { "/boxes/": resolve(appDir, "dist/renderer") },
      tls: identity,
    });
    env.AGENTBOX_SERVER_URL = fake.url;
    env.AGENTBOX_DATA_DIR = dataDir;
    env.AGENTBOX_SERVER_TOKEN = "smoke-token";
  }
  userDataDir = mkdtempSync(join(tmpdir(), "agentbox-e2e-profile-"));
  appArgs = [appDir, `--user-data-dir=${userDataDir}`];
  app = await electron.launch({ args: appArgs, env });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app?.close().catch(() => undefined);
  await fake?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

test("opens the main window from the server", async () => {
  expect(await page.title()).toBe("Agent Box");
  await expect(page.getByRole("menubar")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Boxes" })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Box actions" })).toBeVisible();
  await expect(page.getByText(/updated \d\d:\d\d:\d\d/)).toBeVisible({ timeout: 15_000 });
  expect(page.url()).toContain("/boxes/");
});

test("hands the page the token once, for the session cookie", async () => {
  const bridge = await page.evaluate(() => {
    const b = (
      window as unknown as {
        agentbox?: { token?: unknown; takeToken: () => string | null; serverUrl: string };
      }
    ).agentbox;
    return b ? { onBridge: "token" in b, again: b.takeToken(), serverUrl: b.serverUrl } : null;
  });
  // The page took the token at start, so the bridge has none left to give.
  expect(bridge).toMatchObject({ onBridge: false, again: null });
  if (fake) {
    await expect
      .poll(() =>
        fake?.requests.some((r) => r.startsWith("POST /api/v1/auth/session Bearer smoke-token")),
      )
      .toBe(true);
  }
});

test("keeps the single-instance lock", () => {
  // The second instance hands over to the first and quits at once. It is
  // spawned directly, with the switches Playwright gave the first; see
  // `secondInstanceCommand`.
  const command = secondInstanceCommand(appArgs, env);
  const second = spawnSync(String(app.process().spawnfile), command.args, {
    env: command.env,
    cwd: appDir,
    timeout: 20_000,
  });
  expect(second.status, describeExit(second)).toBe(0);
  expect(app.windows()).toHaveLength(1);
});

test("opens New Box with Ctrl+Shift+N and closes it with Escape", async () => {
  await page.locator("body").click({ position: { x: 5, y: 200 } });
  await page.keyboard.press("Control+Shift+N");
  await expect(page.getByRole("dialog", { name: "New Box" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "New Box" })).toBeHidden();
});

test("toggles the details panel with Ctrl+Shift+D", async () => {
  const details = page.getByRole("complementary", { name: "Details" });
  const before = await details.isVisible();
  await page.keyboard.press("Control+Shift+D");
  await expect(details).toBeVisible({ visible: !before });
  await page.keyboard.press("Control+Shift+D");
  await expect(details).toBeVisible({ visible: before });
});

test("types into a running box's terminal and sees the echo", async () => {
  const boxId = process.env.AGENTBOX_E2E_BOX;
  test.skip(!boxId, "Set AGENTBOX_E2E_BOX to a running box id to run this test.");
  // The box can sit in any project, so look at all of them. The app
  // restores its saved selection, which this test mustn't depend on.
  await page.getByRole("option", { name: /^All projects/ }).click();
  await expect(page.getByRole("option", { name: /^All projects/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByLabel("Filter boxes").fill(boxId as string);
  // Find the row by its key, not its text. A live update can replace the
  // row between Playwright's checks and its click, so retry the double-click
  // until the terminal opens. Opening a box that is already open only
  // selects its tab, so a repeat is safe.
  const row = page.locator(`tr[data-key="${boxId as string}"]`);
  const terminal = page.locator(".bx-terminal-pane:not([hidden]) .xterm");
  await expect(async () => {
    await row.dblclick({ timeout: 5_000 });
    await expect(terminal).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 45_000 });
  // The terminal must be tall enough for Claude's input line, whatever
  // split the window has.
  await expect
    .poll(() => page.locator(".bx-terminal-pane:not([hidden]) .xterm-rows > div").count())
    .toBeGreaterThanOrEqual(10);
  await terminal.click();
  const marker = `agentbox-e2e-${Date.now()}`;
  await page.keyboard.type(marker);
  await expect(page.locator(".bx-terminal-pane:not([hidden]) .xterm-rows")).toContainText(marker, {
    timeout: 15_000,
  });
  // Erase the marker so the session's prompt is left as it was.
  for (let i = 0; i < marker.length; i += 1) await page.keyboard.press("Backspace");
  await page.getByLabel("Filter boxes").fill("");
});

test("refuses to open a path the server didn't report, or a non-web link", async () => {
  // Record what reaches the desktop instead of opening it, so that a guard
  // that lets something through opens nothing on the test host.
  await app.evaluate(({ shell }) => {
    const reached: string[] = [];
    (globalThis as { reached?: string[] }).reached = reached;
    shell.openPath = async (p: string) => {
      reached.push(p);
      return "";
    };
    shell.openExternal = async (u: string) => {
      reached.push(u);
    };
  });
  // A path no server reports, whether the fake or a real host.
  const path = `/nonexistent-agentbox-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const results = await page.evaluate(async (p) => {
    const b = (
      window as unknown as {
        agentbox: {
          openPath: (p: string) => Promise<{ ok: boolean; error?: string }>;
          openExternal: (u: string) => Promise<{ ok: boolean; error?: string }>;
        };
      }
    ).agentbox;
    return {
      path: await b.openPath(p),
      file: await b.openExternal("file:///nonexistent-agentbox-e2e.desktop"),
    };
  }, path);
  expect(results.path.ok).toBe(false);
  expect(results.path.error).toContain("not a project or box directory");
  expect(results.file.ok).toBe(false);
  expect(results.file.error).toContain("Only http and https links");
  expect(await app.evaluate(() => (globalThis as { reached?: string[] }).reached)).toEqual([]);
});

// Last, because a failure leaves the window on another page.
test("keeps the window on the app's page when something navigates it away", async () => {
  const target = "http://127.0.0.1:9/elsewhere";
  // Record each navigation the window attempts and whether the app's own
  // handler, which runs first, blocked it.
  await app.evaluate(({ BrowserWindow }) => {
    const seen: { url: string; blocked: boolean }[] = [];
    (globalThis as { seen?: typeof seen }).seen = seen;
    BrowserWindow.getAllWindows()[0]?.webContents.on("will-navigate", (e) => {
      seen.push({ url: e.url, blocked: e.defaultPrevented });
    });
  });
  const before = page.url();
  await page.evaluate((url) => {
    window.location.href = url;
  }, target);
  await expect
    .poll(() => app.evaluate(() => (globalThis as { seen?: unknown[] }).seen))
    .toEqual([{ url: target, blocked: true }]);
  expect(page.url()).toBe(before);
  expect(await page.evaluate(() => typeof (window as { agentbox?: unknown }).agentbox)).toBe(
    "object",
  );
});
