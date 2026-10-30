// The agentbox-review Electron shell: one window on the server's `/review/`
// page, a tray icon with the active run count, desktop notifications for the
// review kinds, a single instance, and `agentbox-review://` deep links.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_PATHS, type NotificationToggles } from "@agentbox/contracts";
import { ApiClient, EventsConnection, isAppPage, isWebUrl } from "@agentbox/ui/core";
import {
  certificateVerdict,
  dataFile,
  pinReader,
  pinnedTransport,
  serverUrl,
} from "@agentbox/ui/electron-main";
import WebSocket from "ws";
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  ipcMain,
  nativeImage,
  session,
  shell,
} from "electron";
import {
  ActiveRuns,
  PROTOCOL,
  launcherHash,
  noticeFor,
  parseDeepLink,
  rendererUrl,
  trayBitmap,
  trayTooltip,
} from "./logic.js";

/** The token, read again for every use, so a server set up after the app started still works. */
function readToken(): string | null {
  if (process.env.AGENTBOX_SERVER_TOKEN) return process.env.AGENTBOX_SERVER_TOKEN;
  try {
    return readFileSync(dataFile(HOME_PATHS.serverToken), "utf8").trim() || null;
  } catch {
    // No token yet: the server isn't set up. The window shows the connection error.
    return null;
  }
}

/**
 * The server's certificate, read again for every connection. Every request,
 * socket, and page load to the server must present it before the token or
 * the cookie goes out.
 */
const readPin = pinReader(dataFile(HOME_PATHS.serverCert));

const config = { serverUrl: serverUrl() };
const DEV_URL = process.env.AGENTBOX_REVIEW_DEV_URL;
/** The pages that get the token; anything else is foreign. */
const APP_PAGES = [rendererUrl(config.serverUrl, null), ...(DEV_URL ? [DEV_URL] : [])];

/** A client with the current token. Call it for every use, so a new token is picked up. */
function client(): ApiClient {
  // The `ws` package sends the token in the upgrade's `Authorization` header,
  // which keeps it out of the event stream's URL.
  return new ApiClient({
    baseUrl: config.serverUrl,
    token: readToken(),
    ...pinnedTransport(WebSocket, readPin),
    socketAuth: "header",
  });
}
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
const active = new ActiveRuns();
let toggles: NotificationToggles = {
  decisionNeeded: true,
  runFinished: true,
  readyToPush: true,
  boxEnded: true,
  roundSummary: true,
};

function updateTray() {
  if (!tray) return;
  tray.setImage(nativeImage.createFromBitmap(trayBitmap(active.count), { width: 32, height: 32 }));
  tray.setToolTip(trayTooltip(active.count));
  tray.setTitle(active.count > 0 ? String(active.count) : "");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayTooltip(active.count), enabled: false },
      { type: "separator" },
      { label: "Open", click: () => show() },
      { label: "Dashboard", click: () => show("#/dashboard") },
      { label: "Start a run", click: () => show("#/launch") },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

function show(hash?: string) {
  if (!win) createWindow(null);
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (hash) win.webContents.send("agentbox:navigate", hash);
}

function createWindow(link: ReturnType<typeof parseDeepLink>) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Agent Box Review",
    backgroundColor: "#0d0d0d",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  // Open web links, such as pull requests, in the default browser. A link
  // from an imported finding can carry any scheme, so others never open.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // A dropped link, a script, or a redirect must not take the window and its
  // token to another page.
  win.webContents.on("will-navigate", (e) => {
    if (!isAppPage(e.url, APP_PAGES)) e.preventDefault();
  });
  win.webContents.on("will-redirect", (e) => {
    if (!isAppPage(e.url, APP_PAGES)) e.preventDefault();
  });
  win.webContents.on("will-attach-webview", (e) => e.preventDefault());
  win.on("close", (e) => {
    // Closing hides the window; the tray keeps counting runs.
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  void win.loadURL(DEV_URL ?? rendererUrl(config.serverUrl, link));
}

async function loadInitialState() {
  try {
    const { runs } = await client().call("runs.list", {});
    active.seed(runs);
    toggles = (await client().call("settings.get", {})).notifications;
  } catch {
    // The server may be starting; the event stream retries and the counts catch up.
  }
  updateTray();
}

/**
 * Follows the event stream with the shared connection, which resumes from
 * the last event it saw after a reconnect, so a notification sent while the
 * socket was down still arrives. When the server can't replay, the counts
 * and toggles reload through REST.
 */
function connectEvents() {
  const conn = new EventsConnection({
    // A factory, so a reconnect reads the token and the certificate again.
    client,
    types: ["run.changed", "notification", "settings.changed"],
    onResync: () => void loadInitialState(),
    onEvent: (event) => {
      if (event.type === "settings.changed") toggles = event.settings.notifications;
      if (active.apply(event)) updateTray();
      const notice = noticeFor(event, toggles);
      if (notice && Notification.isSupported()) {
        const n = new Notification({
          title: notice.title,
          body: notice.body,
          urgency: notice.urgent ? "critical" : "normal",
        });
        n.on("click", () => {
          show(notice.hash);
          void client()
            .call("notifications.read", { params: { notificationId: notice.notificationId } })
            .catch(() => undefined);
        });
        n.show();
      }
    },
  });
  conn.start();
  app.on("before-quit", () => conn.stop());
}

let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
  app.on("second-instance", (_e, argv) => {
    const link = parseDeepLink(argv);
    show(link ? launcherHash(link) : undefined);
  });
  app.on("open-url", (e, url) => {
    e.preventDefault();
    const link = parseDeepLink([url]);
    if (link) show(launcherHash(link));
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("activate", () => show());
  ipcMain.on("agentbox:config", (e) => {
    // Under the Vite dev server the page calls its own origin, which proxies to the server.
    e.returnValue = { serverUrl: DEV_URL ? null : config.serverUrl };
  });
  // The preload asks once per page load and hands the token to the page once.
  ipcMain.on("agentbox:token", (e) => {
    // Only the app's own page gets the token.
    const url = e.senderFrame?.url;
    const trusted = typeof url === "string" && isAppPage(url, APP_PAGES);
    e.returnValue = trusted ? readToken() : null;
  });
  void app.whenReady().then(() => {
    app.setAppUserModelId("agentbox-review");
    // Pages and their sockets on the server's host load only from a server
    // that presents the pinned certificate.
    session.defaultSession.setCertificateVerifyProc((request, callback) =>
      callback(certificateVerdict(request, config.serverUrl, readPin)),
    );
    tray = new Tray(nativeImage.createFromBitmap(trayBitmap(0), { width: 32, height: 32 }));
    tray.on("click", () => show());
    updateTray();
    createWindow(parseDeepLink(process.argv));
    connectEvents();
  });
}
