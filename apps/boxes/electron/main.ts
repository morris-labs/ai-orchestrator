// The Electron main process of the aio app: one window that loads the
// boxes page from aio-server, a tray icon with box counts, desktop
// notifications for box events, a single-instance lock, and the bridge
// calls that need the host (external terminals, the review app, pickers).
import { HOME_PATHS, boxWorkDir, type BoxView } from "@aio/contracts";
import type { HubProxy } from "@aio/contracts/gui-client";
import {
  ApiClient,
  EventsConnection,
  type WebSocketCtor,
  errorMessage,
  isAllowedOpenPath,
  isAppPage,
  isWebUrl,
} from "@aio/ui/core";
import {
  CONNECTION_ARG,
  certificateVerdict,
  dataFile,
  guiClientDir,
  openConnectionWindow,
  prepareConnection,
  pinReader,
  pinnedTransport,
  serverUrl,
} from "@aio/ui/electron-main";
import { execFileSync, spawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import {
  app,
  BrowserWindow,
  clipboard,
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
  APP_USER_MODEL_ID,
  applicationMenuTemplate,
  childEnv,
  cliAttachArgs,
  closeHidesToTray,
  findTerminal,
  hostOsOf,
  isBoxNotification,
  macTerminalCommand,
  mayAskGsettings,
  needsLocalPage,
  permissionAllowed,
  reviewLaunch,
  showRetained,
  isMachineIdArg,
  terminalCommand,
  usesWindowClass,
  windowsBundledCli,
  windowsTerminalCommand,
  trayCounts,
  trayIconBitmap,
  trayText,
  type TrayCounts,
} from "./logic";

const HOST_OS = hostOsOf(process.platform);
let SERVER_URL = serverUrl();
let BOXES_URL = process.env.AIO_BOXES_URL ?? `${SERVER_URL}/boxes/`;
/** The proxy to an enrolled hub, or `null` for the local server. */
let hubProxy: HubProxy | null = null;
/** The copy of the page built into the app, shown when the server doesn't answer. */
const LOCAL_PAGE = join(__dirname, "../renderer/index.html");
/** The pages that get the token and the bridge; anything else is foreign. */
let APP_PAGES = [BOXES_URL, pathToFileURL(LOCAL_PAGE).href];

/** True when an IPC message comes from one of the app's own pages. */
function fromApp(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url;
  return typeof url === "string" && isAppPage(url, APP_PAGES);
}

const REFUSED: BridgeResult = {
  ok: false,
  error: "The request didn't come from the AI Orchestrator page.",
};

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let counts: TrayCounts | null = null;

function readToken(): string | null {
  // With a hub, this is the token that works only on this app's own proxy.
  if (hubProxy) return hubProxy.token;
  // A test or a wrapper can hand the token over without the file.
  if (process.env.AIO_SERVER_TOKEN) return process.env.AIO_SERVER_TOKEN;
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
    ...(hubProxy
      ? { WebSocket: WebSocket as unknown as WebSocketCtor }
      : pinnedTransport(WebSocket, readPin)),
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

function detached(file: string, args: string[], verbatim = false): Promise<BridgeResult> {
  return new Promise((resolve) => {
    try {
      // The token stays in this process: a terminal, its shell, and the
      // review app don't get it.
      const child = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        env: childEnv(process.env),
        // Windows only: `windowsTerminalCommand` quotes for cmd.exe itself.
        windowsVerbatimArguments: verbatim,
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
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Opens the window with the local or hub connection setting. */
function showConnection(notice: string | null = null) {
  openConnectionWindow(
    {
      createWindow: () =>
        new BrowserWindow({
          width: 520,
          height: 560,
          title: "Connection",
          backgroundColor: "#1b1c1e",
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
        }),
      relaunch: () => {
        quitting = true;
        app.relaunch({ args: process.argv.slice(1).filter((a) => a !== CONNECTION_ARG) });
        app.quit();
      },
    },
    guiClientDir(app.getPath("appData")),
    hostname().split(".")[0] || "this-pc",
    notice,
  );
}

function createWindow() {
  win = new BrowserWindow({
    width: 1250,
    height: 820,
    title: "AI Orchestrator",
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
  win.webContents.on("did-fail-load", (_e, errorCode, _desc, url, isMainFrame) => {
    const current = win?.webContents.getURL() ?? "";
    if (!needsLocalPage({ url, errorCode, isMainFrame }, BOXES_URL, current, APP_PAGES)) return;
    void win?.loadFile(LOCAL_PAGE);
    retryServerPage();
  });
  win.on("close", (e) => {
    if (!quitting && tray && hideToTray) {
      e.preventDefault();
      win?.hide();
    }
  });
  void win.loadURL(BOXES_URL);
}

/**
 * The GNOME Shell extensions that are on, for `closeHidesToTray`; `null`
 * when `gsettings` can't tell.
 */
function enabledExtensions(): string | null {
  try {
    return execFileSync("gsettings", ["get", "org.gnome.shell", "enabled-extensions"], {
      encoding: "utf8",
      timeout: 2000,
    });
  } catch {
    return null;
  }
}

/** Whether closing the window hides it into the tray; decided once at startup. */
const hideToTray = closeHidesToTray(
  process.env,
  mayAskGsettings(HOST_OS, process.env) ? enabledExtensions() : null,
);

/** Starts the review app, prefilled with a project and box when given. */
async function launchReview(link: {
  projectId?: string;
  boxId?: string;
  machineId?: string;
}): Promise<BridgeResult> {
  const how = reviewLaunch(HOST_OS, link, process.env.AIO_REVIEW_BIN);
  if ("file" in how) return detached(how.file, how.args);
  try {
    await shell.openExternal(how.url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * The `aio` CLI for consoles on Windows: the one in the package's runtime,
 * else `aio` on PATH.
 */
function windowsCli(): string[] {
  const bundled = windowsBundledCli(process.resourcesPath);
  try {
    for (const file of bundled) statSync(file);
    return bundled;
  } catch {
    return ["aio.cmd"];
  }
}

/** Whether Windows Terminal's `wt.exe` alias exists. */
function hasWindowsTerminal(): boolean {
  const local = process.env.LOCALAPPDATA;
  if (!local) return false;
  try {
    statSync(join(local, "Microsoft", "WindowsApps", "wt.exe"));
    return true;
  } catch {
    return false;
  }
}

/** Opens a box in an external terminal on macOS or Windows. */
async function openTerminalElsewhere(req: ExternalTerminalRequest, argv: string[]) {
  if (HOST_OS === "darwin") {
    const cmd = macTerminalCommand(argv);
    return detached(cmd.file, cmd.args);
  }
  const cmd = windowsTerminalCommand(
    windowsCli(),
    cliAttachArgs(req),
    req.boxId,
    hasWindowsTerminal(),
  );
  if (!cmd) return { ok: false, error: `Can't open ${req.boxId} in a console on Windows.` };
  return detached(cmd.file, cmd.args, cmd.verbatim);
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
      { label: "Show AI Orchestrator", click: showWindow },
      { label: "Connection...", click: () => showConnection() },
      {
        label: "Review",
        click: () => {
          void launchReview({});
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

/** Desktop notifications on screen. */
const shownNotifications = new Map<Notification, boolean>();
// Windows emits `close` when a toast moves to the Action Center, where it stays clickable.
const releaseOnClose = process.platform !== "win32";

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
      // A reconnect that replays gets no resync, and the close cleared the counts.
      if (s === "open") refreshCounts();
    },
    onEvent: (ev) => {
      if (ev.type === "box.changed") refreshCounts();
      if (ev.type === "notification" && isBoxNotification(ev) && Notification.isSupported()) {
        const urgent = ev.severity === "error";
        const n = new Notification({
          title: ev.title,
          body: ev.body,
          urgency: urgent ? "critical" : "normal",
        });
        showRetained(
          shownNotifications,
          n,
          () => {
            showWindow();
            if (ev.boxId) win?.webContents.send("aio:select-box", ev.boxId);
            void client()
              .call("notifications.read", { params: { notificationId: ev.notificationId } })
              .catch(() => undefined);
          },
          { urgent, releaseOnClose },
        );
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
  ipcMain.on("aio:relaunch", (e) => {
    if (!fromApp(e)) return;
    app.relaunch({
      execPath: process.platform === "linux" ? "/usr/bin/aio-boxes" : process.execPath,
    });
    app.exit(0);
  });

  ipcMain.on("aio:init", (e) => {
    e.returnValue = {
      serverUrl: SERVER_URL,
      remoteHub: hubProxy !== null,
      appVersion: app.getVersion(),
    };
  });
  // The preload asks once per page load and hands the token to the page once.
  ipcMain.on("aio:token", (e) => {
    e.returnValue = fromApp(e) ? readToken() : null;
  });
  ipcMain.handle(
    "aio:open-external-terminal",
    async (e, req: ExternalTerminalRequest): Promise<BridgeResult> => {
      if (!fromApp(e)) return REFUSED;
      try {
        const { argv } = await client().call("boxes.attachCommand", {
          params: { boxId: req.boxId },
          query: { kind: req.kind, ...(req.platform ? { platform: req.platform } : {}) },
        });
        if (HOST_OS !== "linux") return await openTerminalElsewhere(req, argv);
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
    "aio:launch-review",
    async (
      e,
      req: { projectId: string; boxId: string; machineId?: unknown },
    ): Promise<BridgeResult> => {
      if (!fromApp(e)) return REFUSED;
      // The ID ends up in an argv or a URL, so only the plain form passes.
      if (req.machineId !== undefined && !isMachineIdArg(req.machineId)) {
        return { ok: false, error: "The machine ID isn't valid." };
      }
      return launchReview({
        projectId: req.projectId,
        boxId: req.boxId,
        machineId: req.machineId,
      });
    },
  );
  ipcMain.handle("aio:pick-directory", async (e, defaultPath?: string) => {
    if (!fromApp(e)) return null;
    const opts = {
      properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
      defaultPath,
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : (res.filePaths[0] ?? null);
  });
  ipcMain.handle("aio:read-clipboard-text", async (e): Promise<string> =>
    fromApp(e) ? clipboard.readText() : "",
  );
  ipcMain.handle("aio:open-path", async (e, path: string): Promise<BridgeResult> => {
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
  ipcMain.handle("aio:open-external", async (e, url: string): Promise<BridgeResult> => {
    if (!fromApp(e)) return REFUSED;
    if (!isWebUrl(url)) return { ok: false, error: "Only http and https links open externally." };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });
  ipcMain.on("aio:notify", (e, n: unknown) => {
    if (!fromApp(e) || !Notification.isSupported() || typeof n !== "object" || n === null) return;
    const { title, body, urgent, boxId, machineId, notificationId } = n as Record<string, unknown>;
    if (
      typeof title !== "string" ||
      typeof body !== "string" ||
      typeof boxId !== "string" ||
      typeof machineId !== "string" ||
      typeof notificationId !== "string"
    )
      return;
    const note = new Notification({
      title,
      body,
      urgency: urgent === true ? "critical" : "normal",
    });
    showRetained(
      shownNotifications,
      note,
      () => {
        showWindow();
        win?.webContents.send("aio:select-box", boxId, machineId, notificationId);
      },
      { urgent: urgent === true, releaseOnClose },
    );
  });
  ipcMain.on("aio:quit", (e) => {
    if (!fromApp(e)) return;
    quitting = true;
    app.quit();
  });
}

// Sets the X11 window class and the Wayland app_id to the name of the
// desktop entry (aio-boxes.desktop), so the shell ties the window to
// its entry and icon. app.setName changes only the display name.
if (usesWindowClass(HOST_OS)) app.commandLine.appendSwitch("class", "aio-boxes");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName("AI Orchestrator");
  app.on("second-instance", (_e, argv) => {
    if (argv.includes(CONNECTION_ARG)) showConnection();
    else showWindow();
  });
  // macOS: a click on the Dock icon of a running app with no visible window.
  app.on("activate", showWindow);
  app.on("before-quit", () => {
    quitting = true;
  });
  void app.whenReady().then(async () => {
    const { proxy, notice } = await prepareConnection(
      guiClientDir(app.getPath("appData")),
      hostname().split(".")[0] || "this-pc",
    );
    if (proxy) {
      hubProxy = proxy;
      SERVER_URL = proxy.url;
      BOXES_URL = `${proxy.url}/boxes/`;
      APP_PAGES = [BOXES_URL, pathToFileURL(LOCAL_PAGE).href];
    }
    const menu = applicationMenuTemplate(HOST_OS);
    Menu.setApplicationMenu(menu ? Menu.buildFromTemplate(menu) : null);
    // Windows ties notifications to the Start menu shortcut with this id.
    if (HOST_OS === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);
    registerIpc();
    // Pages and their sockets on the server's host load only from a server
    // that presents the pinned certificate.
    session.defaultSession.setCertificateVerifyProc((request, callback) =>
      callback(certificateVerdict(request, SERVER_URL, readPin)),
    );
    // The page needs the clipboard and nothing else: media, geolocation,
    // notifications, and the rest are refused.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) =>
      callback(permissionAllowed(permission, details.requestingUrl || wc.getURL(), APP_PAGES)),
    );
    session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) =>
      permissionAllowed(permission, details.requestingUrl || wc?.getURL() || "", APP_PAGES),
    );
    createWindow();
    tray = new Tray(trayImage("offline"));
    tray.on("click", showWindow);
    updateTray();
    refreshCounts();
    watchEvents();
    // A PC with no server and no enrollment has nothing else to connect to.
    if (notice || process.argv.includes(CONNECTION_ARG) || (!hubProxy && !readToken())) {
      showConnection(notice);
    }
  });
  app.on("window-all-closed", () => {
    if (!tray || !hideToTray) app.quit();
  });
}
