// The agentbox-review Electron shell: one window on the server's `/review/`
// page, a tray icon with the active run count, desktop notifications for the
// review kinds, a single instance, and `agentbox-review://` deep links.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOME_PATHS,
  DEFAULT_SERVER_PORT,
  RunStateSchema,
  ServerStreamFrameSchema,
  GlobalSettingsSchema,
  type NotificationToggles,
} from "@agentbox/contracts";
import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  ipcMain,
  nativeImage,
  shell,
} from "electron";
import { z } from "zod";
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

const here = fileURLToPath(new URL(".", import.meta.url));

function readServerConfig(): { serverUrl: string; token: string | null } {
  const home = homedir();
  let port = DEFAULT_SERVER_PORT;
  try {
    const cfg = JSON.parse(readFileSync(join(home, HOME_PATHS.config), "utf8")) as {
      serverPort?: number;
    };
    if (typeof cfg.serverPort === "number") port = cfg.serverPort;
  } catch {
    // No config file: the default port applies.
  }
  let token: string | null = null;
  try {
    token = readFileSync(join(home, HOME_PATHS.serverToken), "utf8").trim() || null;
  } catch {
    // No token yet: the server isn't set up. The window shows the connection error.
  }
  return {
    serverUrl: process.env.AGENTBOX_SERVER_URL ?? `http://127.0.0.1:${port}`,
    token: process.env.AGENTBOX_SERVER_TOKEN ?? token,
  };
}

const config = readServerConfig();
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

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${config.serverUrl}${path}`, {
    ...init,
    headers: {
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} answered ${res.status}.`);
  return res.status === 204 ? null : res.json();
}

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
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // Open external links, such as pull requests, in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("close", (e) => {
    // Closing hides the window; the tray keeps counting runs.
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
  const dev = process.env.AGENTBOX_REVIEW_DEV_URL;
  void win.loadURL(dev ?? rendererUrl(config.serverUrl, link));
}

async function loadInitialState() {
  try {
    const runs = z.object({ runs: z.array(RunStateSchema) }).parse(await api("/api/v1/runs"));
    active.seed(runs.runs);
    const settings = GlobalSettingsSchema.parse(await api("/api/v1/settings"));
    toggles = settings.notifications;
  } catch {
    // The server may be starting; the event stream retries and the counts catch up.
  }
  updateTray();
}

function connectEvents(attempt = 0) {
  const url = new URL("/api/v1/events", config.serverUrl.replace(/^http/, "ws"));
  url.searchParams.set("types", "run.changed,notification,settings.changed");
  if (config.token) url.searchParams.set("token", config.token);
  const ws = new WebSocket(url);
  ws.onopen = () => {
    attempt = 0;
    ws.send(JSON.stringify({ type: "hello", streamId: null, lastSeq: null }));
    void loadInitialState();
  };
  ws.onmessage = (msg) => {
    let json: unknown;
    try {
      json = JSON.parse(String(msg.data));
    } catch {
      return;
    }
    const frame = ServerStreamFrameSchema.safeParse(json);
    if (!frame.success || frame.data.type === "hello") return;
    const event = frame.data;
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
        void api(`/api/v1/notifications/${encodeURIComponent(notice.notificationId)}/read`, {
          method: "POST",
        }).catch(() => undefined);
      });
      n.show();
    }
  };
  ws.onclose = () => {
    if (quitting) return;
    setTimeout(() => connectEvents(attempt + 1), Math.min(10_000, 500 * 2 ** attempt));
  };
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
    e.returnValue = {
      token: config.token,
      serverUrl: process.env.AGENTBOX_REVIEW_DEV_URL ? null : config.serverUrl,
    };
  });
  void app.whenReady().then(() => {
    app.setAppUserModelId("agentbox-review");
    tray = new Tray(nativeImage.createFromBitmap(trayBitmap(0), { width: 32, height: 32 }));
    tray.on("click", () => show());
    updateTray();
    createWindow(parseDeepLink(process.argv));
    connectEvents();
  });
}
