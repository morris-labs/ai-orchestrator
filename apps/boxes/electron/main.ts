// The Electron main process of the agentbox app: one window that loads the
// boxes page from agentbox-server, a tray icon with box counts, desktop
// notifications for box events, a single-instance lock, and the bridge
// calls that need the host (external terminals, the review app, pickers).
import { HOME_PATHS, type BoxView } from "@agentbox/contracts";
import { ApiClient, EventsConnection, errorMessage } from "@agentbox/ui/core";
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} from "electron";
import type { BridgeResult, ExternalTerminalRequest } from "../src/bridge";
import {
  findTerminal,
  isBoxNotification,
  reviewCommand,
  serverUrl as serverUrlFrom,
  terminalCommand,
  trayCounts,
  trayIconBitmap,
  trayText,
  type TrayCounts,
} from "./logic";

const SERVER_URL = serverUrlFrom(process.env);
const BOXES_URL = process.env.AGENTBOX_BOXES_URL ?? `${SERVER_URL}/boxes/`;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let counts: TrayCounts | null = null;

function readToken(): string | null {
  // A test or a wrapper can hand the token over without the file.
  if (process.env.AGENTBOX_SERVER_TOKEN) return process.env.AGENTBOX_SERVER_TOKEN;
  try {
    return readFileSync(join(homedir(), HOME_PATHS.serverToken), "utf8").trim() || null;
  } catch {
    return null;
  }
}

function client(): ApiClient {
  return new ApiClient({ baseUrl: SERVER_URL, token: readToken() });
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function detached(file: string, args: string[]): Promise<BridgeResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn(file, args, { detached: true, stdio: "ignore" });
      child.once("error", (err) => resolve({ ok: false, error: `${file}: ${err.message}` }));
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
    } catch (err) {
      resolve({ ok: false, error: errorMessage(err) });
    }
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1250,
    height: 820,
    title: "Agent Box",
    backgroundColor: "#1b1c1e",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The server serves the page; when it doesn't answer, the copy built into
  // the app loads instead and shows its "server not reachable" state.
  win.webContents.on("did-fail-load", (_e, _code, _desc, url) => {
    if (url.startsWith(SERVER_URL)) void win?.loadFile(join(__dirname, "../renderer/index.html"));
  });
  win.on("close", (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      win?.hide();
    }
  });
  void win.loadURL(BOXES_URL);
}

function trayImage(state: "running" | "idle" | "offline") {
  const size = 22;
  return nativeImage.createFromBitmap(trayIconBitmap(size, state), { width: size, height: size });
}

function updateTray() {
  if (!tray) return;
  const state = counts === null ? "offline" : counts.running > 0 ? "running" : "idle";
  tray.setImage(trayImage(state));
  tray.setToolTip(trayText(counts));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayText(counts), enabled: false },
      { type: "separator" },
      { label: "Show Agent Box", click: showWindow },
      {
        label: "Review",
        click: () => {
          void detached(process.env.AGENTBOX_REVIEW_BIN || "agentbox-review", []);
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

let countTimer: ReturnType<typeof setTimeout> | null = null;
function refreshCounts() {
  if (countTimer) clearTimeout(countTimer);
  countTimer = setTimeout(() => {
    client()
      .call("boxes.list", {})
      .then((r: { boxes: BoxView[] }) => {
        counts = trayCounts(r.boxes);
      })
      .catch(() => {
        counts = null;
      })
      .finally(updateTray);
  }, 300);
}

function watchEvents() {
  const conn = new EventsConnection({
    client: client(),
    types: ["box.changed", "notification"],
    onResync: refreshCounts,
    onStatus: (s) => {
      if (s === "closed") {
        counts = null;
        updateTray();
      }
    },
    onEvent: (ev) => {
      if (ev.type === "box.changed") refreshCounts();
      if (ev.type === "notification" && isBoxNotification(ev) && Notification.isSupported()) {
        const n = new Notification({
          title: ev.title,
          body: ev.body,
          urgency: ev.severity === "error" ? "critical" : "normal",
        });
        n.on("click", () => {
          showWindow();
          if (ev.boxId) win?.webContents.send("agentbox:select-box", ev.boxId);
          void client()
            .call("notifications.read", { params: { notificationId: ev.notificationId } })
            .catch(() => undefined);
        });
        n.show();
      }
    },
  });
  conn.start();
}

function registerIpc() {
  ipcMain.on("agentbox:init", (e) => {
    e.returnValue = { token: readToken(), serverUrl: SERVER_URL };
  });
  ipcMain.handle(
    "agentbox:open-external-terminal",
    async (_e, req: ExternalTerminalRequest): Promise<BridgeResult> => {
      try {
        const { argv } = await client().call("boxes.attachCommand", {
          params: { boxId: req.boxId },
          query: { kind: req.kind, ...(req.platform ? { platform: req.platform } : {}) },
        });
        const terminal = findTerminal(process.env, executable);
        if (!terminal) {
          return {
            ok: false,
            error:
              "No terminal emulator found. Set $TERMINAL, or install gnome-terminal, xterm, kitty, or alacritty.",
          };
        }
        const cmd = terminalCommand(terminal, argv, req.boxId);
        return await detached(cmd.file, cmd.args);
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
  );
  ipcMain.handle(
    "agentbox:launch-review",
    async (_e, req: { projectId: string; boxId: string }) => {
      const cmd = reviewCommand(req.projectId, req.boxId, process.env.AGENTBOX_REVIEW_BIN);
      return detached(cmd.file, cmd.args);
    },
  );
  ipcMain.handle("agentbox:pick-directory", async (_e, defaultPath?: string) => {
    const opts = {
      properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
      defaultPath,
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  ipcMain.handle("agentbox:open-path", async (_e, path: string): Promise<BridgeResult> => {
    const error = await shell.openPath(path);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle("agentbox:open-external", async (_e, url: string): Promise<BridgeResult> => {
    if (!/^https?:\/\//.test(url))
      return { ok: false, error: "Only http and https links open externally." };
    await shell.openExternal(url);
    return { ok: true };
  });
  ipcMain.on("agentbox:quit", () => {
    quitting = true;
    app.quit();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName("Agent Box");
  app.on("second-instance", showWindow);
  app.on("before-quit", () => {
    quitting = true;
  });
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();
    tray = new Tray(trayImage("offline"));
    tray.on("click", showWindow);
    updateTray();
    refreshCounts();
    watchEvents();
  });
  app.on("window-all-closed", () => {
    if (!tray) app.quit();
  });
}
