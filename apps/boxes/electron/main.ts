// The Electron main process of the agentbox app: one window that loads the
// boxes page from agentbox-server, a tray icon with box counts, desktop
// notifications for box events, a single-instance lock, and the bridge
// calls that need the host (external terminals, the review app, pickers).
import { HOME_PATHS, boxWorkDir, type BoxView } from "@agentbox/contracts";
import {
  ApiClient,
  EventsConnection,
  errorMessage,
  isAllowedOpenPath,
  isAppPage,
  isWebUrl,
} from "@agentbox/ui/core";
import {
  certificateVerdict,
  dataFile,
  pinReader,
  pinnedTransport,
  serverUrl,
} from "@agentbox/ui/electron-main";
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  Menu,
  nativeImage,
  Notification,
  session,
  shell,
  Tray,
} from "electron";
import type { BridgeResult, ExternalTerminalRequest } from "../src/bridge";
import {
  childEnv,
  findTerminal,
  isBoxNotification,
  reviewCommand,
  terminalCommand,
  trayCounts,
  trayIconBitmap,
  trayText,
  type TrayCounts,
} from "./logic";

const SERVER_URL = serverUrl();
const BOXES_URL = process.env.AGENTBOX_BOXES_URL ?? `${SERVER_URL}/boxes/`;
/** The copy of the page built into the app, shown when the server doesn't answer. */
const LOCAL_PAGE = join(__dirname, "../renderer/index.html");
/** The pages that get the token and the bridge; anything else is foreign. */
const APP_PAGES = [BOXES_URL, pathToFileURL(LOCAL_PAGE).href];

/** True when an IPC message comes from one of the app's own pages. */
function fromApp(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url;
  return typeof url === "string" && isAppPage(url, APP_PAGES);
}

const REFUSED: BridgeResult = {
  ok: false,
  error: "The request didn't come from the Agent Box page.",
};

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let counts: TrayCounts | null = null;

function readToken(): string | null {
  // A test or a wrapper can hand the token over without the file.
  if (process.env.AGENTBOX_SERVER_TOKEN) return process.env.AGENTBOX_SERVER_TOKEN;
  try {
    return readFileSync(dataFile(HOME_PATHS.serverToken), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * The server's certificate, read again for every connection. Every request,
 * socket, and page load to the server must present it before the token or
 * the cookie goes out.
 */
const readPin = pinReader(dataFile(HOME_PATHS.serverCert));

/** A client with the current token. Call it for every use, so a new token is picked up. */
function client(): ApiClient {
  // The `ws` package sends the token in the upgrade's `Authorization` header,
  // which keeps it out of the event stream's URL.
  return new ApiClient({
    baseUrl: SERVER_URL,
    token: readToken(),
    ...pinnedTransport(WebSocket, readPin),
    socketAuth: "header",
  });
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
      // The token stays in this process: a terminal, its shell, and the
      // review app don't get it.
      const child = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        env: childEnv(process.env),
      });
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
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // A dropped link, a script, or a redirect must not take the window, its
  // token, and its bridge to another page.
  win.webContents.on("will-navigate", (e) => {
    if (!isAppPage(e.url, APP_PAGES)) e.preventDefault();
  });
  win.webContents.on("will-redirect", (e) => {
    if (!isAppPage(e.url, APP_PAGES)) e.preventDefault();
  });
  win.webContents.on("will-attach-webview", (e) => e.preventDefault());
  // The server serves the page; when it doesn't answer, the copy built into
  // the app loads instead and shows its "server not reachable" state. That
  // copy can't get the session cookie its WebSockets need, so the server's
  // page replaces it once the server answers.
  win.webContents.on("did-fail-load", (_e, _code, _desc, url) => {
    if (!url.startsWith(SERVER_URL)) return;
    void win?.loadFile(LOCAL_PAGE);
    retryServerPage();
  });
  win.on("close", (e) => {
    if (!quitting && tray) {
      e.preventDefault();
      win?.hide();
    }
  });
  void win.loadURL(BOXES_URL);
}

let serverRetry: ReturnType<typeof setTimeout> | null = null;
/** Loads the server's page again once the server answers, while the local copy shows. */
function retryServerPage() {
  if (serverRetry) return;
  serverRetry = setTimeout(() => {
    serverRetry = null;
    if (!win || win.webContents.getURL().startsWith(SERVER_URL)) return;
    client()
      .call("health", {})
      .then(() => void win?.loadURL(BOXES_URL))
      .catch(retryServerPage);
  }, 5000);
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
    // A factory, so a reconnect reads the token and the certificate again.
    client,
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

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Project roots and box directories, as the server reports them. */
async function reportedDirectories(): Promise<string[]> {
  const api = client();
  const [p, b] = await Promise.all([api.call("projects.list", {}), api.call("boxes.list", {})]);
  return [
    ...p.projects.map((x) => x.project.root),
    ...b.boxes.flatMap((x) => [x.box.targetDir, boxWorkDir(x.box)]),
  ];
}

function registerIpc() {
  ipcMain.on("agentbox:init", (e) => {
    e.returnValue = { serverUrl: SERVER_URL };
  });
  // The preload asks once per page load and hands the token to the page once.
  ipcMain.on("agentbox:token", (e) => {
    e.returnValue = fromApp(e) ? readToken() : null;
  });
  ipcMain.handle(
    "agentbox:open-external-terminal",
    async (e, req: ExternalTerminalRequest): Promise<BridgeResult> => {
      if (!fromApp(e)) return REFUSED;
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
    async (e, req: { projectId: string; boxId: string }): Promise<BridgeResult> => {
      if (!fromApp(e)) return REFUSED;
      const cmd = reviewCommand(req.projectId, req.boxId, process.env.AGENTBOX_REVIEW_BIN);
      return detached(cmd.file, cmd.args);
    },
  );
  ipcMain.handle("agentbox:pick-directory", async (e, defaultPath?: string) => {
    if (!fromApp(e)) return null;
    const opts = {
      properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
      defaultPath,
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  ipcMain.handle("agentbox:open-path", async (e, path: string): Promise<BridgeResult> => {
    if (!fromApp(e)) return REFUSED;
    // Only directories the server reports open; a file would run with its
    // default handler.
    let allowed: string[];
    try {
      allowed = await reportedDirectories();
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
    if (!isAllowedOpenPath(path, allowed) || !isDirectory(path)) {
      return { ok: false, error: `${String(path)} is not a project or box directory.` };
    }
    const error = await shell.openPath(path);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle("agentbox:open-external", async (e, url: string): Promise<BridgeResult> => {
    if (!fromApp(e)) return REFUSED;
    if (!isWebUrl(url)) return { ok: false, error: "Only http and https links open externally." };
    await shell.openExternal(url);
    return { ok: true };
  });
  ipcMain.on("agentbox:quit", (e) => {
    if (!fromApp(e)) return;
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
    // Pages and their sockets on the server's host load only from a server
    // that presents the pinned certificate.
    session.defaultSession.setCertificateVerifyProc((request, callback) =>
      callback(certificateVerdict(request, SERVER_URL, readPin)),
    );
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
