// The aio-review Electron shell: one window on the server's `/review/`
// page, a tray icon with the active run count on every online machine,
// desktop notifications for the review kinds from those machines, a single
// instance, and `aio-review://` deep links.
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { HOME_PATHS, type NotificationToggles } from "@aio/contracts";
import type { HubProxy } from "@aio/contracts/gui-client";
import {
  ApiClient,
  EventsConnection,
  type WebSocketCtor,
  createMachineClient,
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
  APP_USER_MODEL_ID,
  FleetActiveRuns,
  type NoticeMachine,
  hostOsOf,
  protocolClientArgs,
  usesWindowClass,
  PendingNavigation,
  Reloader,
  launcherHash,
  lostAppPage,
  noticeFor,
  offlinePageUrl,
  parseDeepLink,
  rendererUrl,
  trayBitmap,
  trayTooltip,
} from "./logic.js";

/** The token, read again for every use, so a server set up after the app started still works. */
function readToken(): string | null {
  // With a hub, this is the token that works only on this app's own proxy.
  if (hubProxy) return hubProxy.token;
  if (process.env.AIO_SERVER_TOKEN) return process.env.AIO_SERVER_TOKEN;
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

/** The proxy to an enrolled hub, or `null` for the local server. */
let hubProxy: HubProxy | null = null;
const config = { serverUrl: serverUrl() };
const DEV_URL = process.env.AIO_REVIEW_DEV_URL;
/** The pages that get the token; anything else is foreign. */
let APP_PAGES = [rendererUrl(config.serverUrl, null), ...(DEV_URL ? [DEV_URL] : [])];

/** The client options with the current token. */
function clientOptions() {
  // The `ws` package sends the token in the upgrade's `Authorization` header,
  // which keeps it out of the event stream's URL.
  return {
    baseUrl: config.serverUrl,
    token: readToken(),
    ...(hubProxy
      ? { WebSocket: WebSocket as unknown as WebSocketCtor }
      : pinnedTransport(WebSocket, readPin)),
    socketAuth: "header" as const,
  };
}

/** A client with the current token. Call it for every use, so a new token is picked up. */
function client(): ApiClient {
  return new ApiClient(clientOptions());
}

/** A client for another machine, through this server and the hub. */
function machineClient(machineId: string): ApiClient {
  return createMachineClient(clientOptions(), machineId);
}
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
/** The active runs on this machine and on every other online one. */
const fleet = new FleetActiveRuns({
  listMachines: async () => (await client().call("machines.list", {})).machines,
  listRuns: async (machineId) => (await machineClient(machineId).call("runs.list", {})).runs,
  connect: (machineId, handlers, position) => {
    const conn = new EventsConnection({
      // A factory, so a reconnect reads the token and the certificate again.
      client: () => machineClient(machineId),
      types: ["run.changed", "notification"],
      position,
      ...handlers,
    });
    conn.start();
    return conn;
  },
  onCount: () => updateTray(),
  onNotification: (machine, event) => notify(event, machine),
});
const active = fleet.local;
let toggles: NotificationToggles = {
  decisionNeeded: true,
  runFinished: true,
  readyToPush: true,
  boxEnded: true,
  roundSummary: true,
};

function updateTray() {
  if (!tray) return;
  const count = fleet.count;
  tray.setImage(nativeImage.createFromBitmap(trayBitmap(count), { width: 32, height: 32 }));
  tray.setToolTip(trayTooltip(count));
  tray.setTitle(count > 0 ? String(count) : "");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: trayTooltip(count), enabled: false },
      { type: "separator" },
      { label: "Open", click: () => show() },
      { label: "Dashboard", click: () => show("#/dashboard") },
      { label: "Start a run", click: () => show("#/launch") },
      { label: "Connection...", click: () => showConnection() },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

/** A route asked for before the page could take it. */
const pending = new PendingNavigation();
/** Desktop notifications on screen: a collected one no longer emits `click`. */
const shownNotices = new Set<Notification>();
/** The app page the window loads, kept for the retry after a failed load. */
let pageUrl = "";

function isApp(url: string): boolean {
  return isAppPage(url, APP_PAGES);
}

/** True when the window shows the app page and has finished loading it. */
function pageReady(): boolean {
  return !!win && !win.webContents.isLoading() && isApp(win.webContents.getURL());
}

function show(hash?: string) {
  // `second-instance` and `open-url` can come before the app is ready, and
  // a window can't exist yet: keep the route for the first page load.
  if (!app.isReady()) {
    if (hash) pending.request(hash, false);
    return;
  }
  if (!win) createWindow(null);
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (!hash) return;
  const now = pending.request(hash, pageReady());
  if (now) win.webContents.send("aio:navigate", now);
}

let serverRetry: ReturnType<typeof setTimeout> | null = null;
/** Loads the app page again once the server answers, while the offline page shows. */
function retryServerPage() {
  if (serverRetry) return;
  serverRetry = setTimeout(() => {
    serverRetry = null;
    if (!win || isApp(win.webContents.getURL())) return;
    client()
      .call("health", {})
      .then(() => void win?.loadURL(pageUrl))
      .catch(retryServerPage);
  }, 5000);
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
          backgroundColor: "#0d0d0d",
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

function createWindow(link: ReturnType<typeof parseDeepLink>) {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "AI Orchestrator Review",
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
  // A page that cancels its unload cancels the quit as well, so closing the
  // window afterward must hide it again.
  win.webContents.on("will-prevent-unload", () => {
    quitting = false;
  });
  // When the server doesn't answer, show a small page that says so, and
  // load the app page again once the server answers.
  win.webContents.on("did-fail-load", (_e, errorCode, _desc, url, isMainFrame) => {
    const current = win?.webContents.getURL() ?? "";
    if (!lostAppPage({ url, errorCode, isMainFrame }, current, isApp)) return;
    void win?.loadURL(offlinePageUrl(config.serverUrl));
    retryServerPage();
  });
  // A route asked for while the page loaded goes to it now; the preload
  // keeps it until the page listens.
  win.webContents.on("did-finish-load", () => {
    if (!win || !isApp(win.webContents.getURL())) return;
    const hash = pending.take();
    if (hash) win.webContents.send("aio:navigate", hash);
  });
  win.on("close", (e) => {
    // Closing hides the window; the tray keeps counting runs.
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  pageUrl = DEV_URL ?? rendererUrl(config.serverUrl, link);
  void win.loadURL(pageUrl);
}

/** Counts `settings.changed` events, so a reload doesn't undo a newer one. */
let settingsVersion = 0;

/**
 * Loads the active runs and the notification toggles through REST. Events
 * that arrive meanwhile are newer than the result, so they keep their say.
 * Throws when the server can't answer, so that `reloader` tries again.
 */
async function loadInitialState() {
  const since = active.mark();
  const settingsSince = settingsVersion;
  const [{ runs }, settings] = await Promise.all([
    client().call("runs.list", {}),
    client().call("settings.get", {}),
  ]);
  active.seed(runs, since);
  if (settingsVersion === settingsSince) toggles = settings.notifications;
  updateTray();
}

/** Runs `loadInitialState` until it succeeds, since the server may still be starting. */
const reloader = new Reloader(loadInitialState);

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
    onResync: () => reloader.request(),
    onEvent: (event) => {
      if (event.type === "settings.changed") {
        settingsVersion += 1;
        toggles = event.settings.notifications;
      }
      if (active.apply(event)) updateTray();
      notify(event, fleet.localNoticeMachine());
    },
  });
  conn.start();
  fleet.start();
  // `will-quit` comes once the quit can no longer be cancelled; a quit that
  // a page cancels after `before-quit` keeps the stream.
  app.on("will-quit", () => {
    conn.stop();
    reloader.stop();
    fleet.stop();
  });
}

/**
 * Shows the desktop notification for `event`, if any. With `machine`, the
 * title names it, and for another machine a click opens the run there and
 * marks the notification read on that machine.
 */
function notify(event: Parameters<typeof noticeFor>[0], machine?: NoticeMachine) {
  const notice = noticeFor(event, toggles, Date.now(), machine);
  if (!notice || !Notification.isSupported()) return;
  const n = new Notification({
    title: notice.title,
    body: notice.body,
    urgency: notice.urgent ? "critical" : "normal",
  });
  shownNotices.add(n);
  n.on("close", () => shownNotices.delete(n));
  n.on("click", () => {
    shownNotices.delete(n);
    show(notice.hash);
    const c = machine && !machine.isLocal ? machineClient(machine.id) : client();
    void c
      .call("notifications.read", { params: { notificationId: notice.notificationId } })
      .catch(() => undefined);
  });
  n.show();
}

let quitting = false;

// Sets the X11 window class and the Wayland app_id to the name of the
// desktop entry (aio-review.desktop), so the shell ties the window to
// its entry and icon. app.setName changes only the display name.
const HOST_OS = hostOsOf(process.platform);
if (usesWindowClass(HOST_OS)) app.commandLine.appendSwitch("class", "aio-review");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  const [scheme, exe, exeArgs] = protocolClientArgs(
    HOST_OS,
    process.defaultApp === true,
    process.execPath,
    process.argv[1] === undefined ? undefined : resolve(process.argv[1]),
  );
  if (exe === undefined) app.setAsDefaultProtocolClient(scheme);
  else app.setAsDefaultProtocolClient(scheme, exe, exeArgs);
  app.on("second-instance", (_e, argv) => {
    if (argv.includes(CONNECTION_ARG)) return showConnection();
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
  ipcMain.on("aio:config", (e) => {
    // Under the Vite dev server the page calls its own origin, which proxies to the server.
    e.returnValue = { serverUrl: DEV_URL ? null : config.serverUrl };
  });
  // The preload asks once per page load and hands the token to the page once.
  ipcMain.on("aio:token", (e) => {
    // Only the app's own page gets the token.
    const url = e.senderFrame?.url;
    const trusted = typeof url === "string" && isAppPage(url, APP_PAGES);
    e.returnValue = trusted ? readToken() : null;
  });
  void app.whenReady().then(async () => {
    const { proxy, notice } = await prepareConnection(
      guiClientDir(app.getPath("appData")),
      hostname().split(".")[0] || "this-pc",
    );
    if (proxy) {
      hubProxy = proxy;
      config.serverUrl = proxy.url;
      APP_PAGES = [rendererUrl(proxy.url, null), ...(DEV_URL ? [DEV_URL] : [])];
    }
    // Windows only: ties notifications to the installer's Start menu shortcut.
    if (HOST_OS === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);
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
    // A PC with no server and no enrollment has nothing else to connect to.
    if (notice || process.argv.includes(CONNECTION_ARG) || (!hubProxy && !readToken())) {
      showConnection(notice);
    }
  });
}
