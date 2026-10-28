// A smoke test of the packaged boxes app on a real host: the window opens
// on the server's page, the menus and chords work, and, when
// AGENTBOX_E2E_BOX names a running box, its terminal echoes what you type.
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const appDir = resolve(import.meta.dirname, "..");
const mainFile = resolve(appDir, "dist/electron/main.cjs");

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  if (!existsSync(mainFile)) throw new Error(`Build the app first: ${mainFile} is missing.`);
  app = await electron.launch({
    args: [appDir],
    env: {
      ...process.env,
      AGENTBOX_SERVER_URL: process.env.AGENTBOX_SERVER_URL ?? "http://127.0.0.1:20400",
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await app?.close().catch(() => undefined);
});

test("opens the main window from the server", async () => {
  expect(await page.title()).toBe("Agent Box");
  await expect(page.getByRole("menubar")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Boxes" })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Box actions" })).toBeVisible();
  await expect(page.getByText(/updated \d\d:\d\d:\d\d/)).toBeVisible({ timeout: 15_000 });
  expect(page.url()).toContain("/boxes/");
});

test("exposes the Electron bridge with a token", async () => {
  const bridge = await page.evaluate(() => {
    const b = (window as unknown as { agentbox?: { token: string | null; serverUrl: string } })
      .agentbox;
    return b
      ? { hasToken: typeof b.token === "string" && b.token.length > 0, serverUrl: b.serverUrl }
      : null;
  });
  expect(bridge).not.toBeNull();
  expect(bridge?.hasToken).toBe(true);
});

test("keeps the single-instance lock", async () => {
  const second = await electron.launch({ args: [appDir] });
  // The second instance hands over to the first and quits at once.
  await expect.poll(() => second.process().exitCode, { timeout: 15_000 }).not.toBeNull();
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
  await page.getByLabel("Filter boxes").fill(boxId as string);
  const row = page.getByRole("row").filter({ hasText: boxId as string });
  await row.dblclick();
  const terminal = page.locator(".bx-terminal-pane:not([hidden]) .xterm");
  await expect(terminal).toBeVisible({ timeout: 30_000 });
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
