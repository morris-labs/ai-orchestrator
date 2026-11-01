// Pure logic of the Electron main process, kept apart from `electron` so
// that tests can run it under Node.
import type { BoxView, Notification, NotificationKind } from "@aio/contracts";
import { isAppPage } from "@aio/ui/core";

// ---------------------------------------------------------------------------
// The page

/** Chromium's error code for a load that was cancelled, as a blocked navigation is. */
export const ERR_ABORTED = -3;

/** A `did-fail-load` event's details. */
export interface LoadFailure {
  url: string;
  errorCode: number;
  isMainFrame: boolean;
}

/**
 * True when a failed load must show the copy of the page built into the
 * app: the main frame failed to load the app's page at `boxesUrl`. A frame
 * inside the page leaves the page as it is. So does a load that was
 * cancelled, such as a redirect the window blocked, while `currentUrl`, the
 * page the window shows, is one of `appPages`.
 */
export function needsLocalPage(
  failure: LoadFailure,
  boxesUrl: string,
  currentUrl: string,
  appPages: readonly string[],
): boolean {
  if (!failure.isMainFrame || !isAppPage(failure.url, [boxesUrl])) return false;
  return failure.errorCode !== ERR_ABORTED || !isAppPage(currentUrl, appPages);
}

// ---------------------------------------------------------------------------
// External terminals

/**
 * The Linux terminal candidates, in order (inventory section 5): `$TERMINAL`,
 * then x-terminal-emulator, gnome-terminal, xterm, kitty, and alacritty.
 */
export function terminalCandidates(env: Record<string, string | undefined>): string[] {
  const list = ["x-terminal-emulator", "gnome-terminal", "xterm", "kitty", "alacritty"];
  const own = env.TERMINAL?.trim();
  return own ? [own, ...list.filter((t) => t !== own)] : list;
}

/** The command that runs `argv` in terminal `terminal`, with each terminal's own syntax. */
export function terminalCommand(
  terminal: string,
  argv: readonly string[],
  title: string,
): { file: string; args: string[] } {
  const name = terminal.split("/").pop() ?? terminal;
  switch (name) {
    case "gnome-terminal":
      return { file: terminal, args: ["--title", title, "--", ...argv] };
    case "kitty":
      return { file: terminal, args: ["--title", title, ...argv] };
    case "alacritty":
      return { file: terminal, args: ["--title", title, "-e", ...argv] };
    case "xterm":
      return { file: terminal, args: ["-T", title, "-e", ...argv] };
    // xfce4-terminal's -e takes one command string; -x takes the rest as argv.
    case "xfce4-terminal":
      return { file: terminal, args: ["--title", title, "-x", ...argv] };
    case "foot":
      return { file: terminal, args: ["--title", title, ...argv] };
    case "wezterm":
      return { file: terminal, args: ["start", "--", ...argv] };
    default:
      return { file: terminal, args: ["-e", ...argv] };
  }
}

/** Finds the first candidate on `PATH`, or `null`. `exists` checks one path. */
export function findTerminal(
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean,
): string | null {
  const dirs = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter(Boolean);
  for (const c of terminalCandidates(env)) {
    if (c.includes("/")) {
      if (exists(c)) return c;
      continue;
    }
    for (const d of dirs) {
      if (exists(`${d}/${c}`)) return `${d}/${c}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tray

export interface TrayCounts {
  running: number;
  stopped: number;
  transitioning: number;
}

export function trayCounts(boxes: readonly Pick<BoxView, "status">[]): TrayCounts {
  return {
    running: boxes.filter((b) => b.status === "running").length,
    stopped: boxes.filter((b) => b.status === "stopped").length,
    transitioning: boxes.filter((b) => b.status === "starting" || b.status === "stopping").length,
  };
}

/** The tray tooltip and status line: `AI Orchestrator: 2 running · 3 not running`. */
export function trayText(counts: TrayCounts | null): string {
  if (counts === null) return "AI Orchestrator: server not reachable";
  const parts = [`${counts.running} running`, `${counts.stopped} not running`];
  if (counts.transitioning > 0) parts.push(`${counts.transitioning} changing`);
  return `AI Orchestrator: ${parts.join(" · ")}`;
}

/**
 * The tray icon as a BGRA bitmap: the accent-colored rounded square of the
 * app, with a status dot in the corner (green when a box runs, gray when
 * none does, red when the server is unreachable).
 */
export function trayIconBitmap(size: number, state: "running" | "idle" | "offline"): Buffer {
  const buf = Buffer.alloc(size * size * 4);
  const accent = [0xd9, 0x77, 0x57];
  const dot =
    state === "running"
      ? [0x5f, 0xb3, 0x7a]
      : state === "idle"
        ? [0x8a, 0x8f, 0x98]
        : [0xd9, 0x6c, 0x6c];
  const r = size * 0.2;
  const dotR = size * 0.22;
  const dotC = size - dotR - 0.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const cx = Math.max(r, Math.min(size - 1 - r, x));
      const cy = Math.max(r, Math.min(size - 1 - r, y));
      const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
      const inDot = (x - dotC) ** 2 + (y - dotC) ** 2 <= dotR * dotR;
      const ring = (x - dotC) ** 2 + (y - dotC) ** 2 <= (dotR + size * 0.06) ** 2;
      let rgb: number[] | null = inside ? accent : null;
      // A prompt mark: a chevron in the window background color.
      const u = x / size;
      const v = y / size;
      if (
        inside &&
        u > 0.22 &&
        u < 0.5 &&
        Math.abs(v - 0.45) < 0.2 &&
        Math.abs(Math.abs(v - 0.45) - (0.5 - u) * 0.75) < 0.06
      ) {
        rgb = [0x1b, 0x1c, 0x1e];
      }
      if (ring && !inDot) rgb = [0x1b, 0x1c, 0x1e];
      if (inDot) rgb = dot;
      if (rgb) {
        buf[i] = rgb[2] as number;
        buf[i + 1] = rgb[1] as number;
        buf[i + 2] = rgb[0] as number;
        buf[i + 3] = 255;
      }
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Notifications and the review app

/** Notification kinds about boxes; the review app shows the run kinds. */
export const BOX_NOTIFICATION_KINDS: readonly NotificationKind[] = ["box_ended"];

/** True for notifications this app shows: box kinds, or any notification about a box but no run. */
export function isBoxNotification(n: Pick<Notification, "kind" | "runId" | "boxId">): boolean {
  return BOX_NOTIFICATION_KINDS.includes(n.kind) || (n.runId === null && n.boxId !== null);
}

/**
 * The argv that launches the review app with the launcher prefilled. The
 * review app also takes an `aio-review://launch?project=&box=&machine=` URL
 * or a bare `?project=&box=` query; the flags are the form this app uses.
 * `binary` comes from `AIO_REVIEW_BIN` when it is set. `machineId` names
 * the machine that holds the box; absent means this one.
 */
export function reviewCommand(
  projectId: string,
  boxId: string,
  binary: string | undefined = undefined,
  machineId: string | undefined = undefined,
): { file: string; args: string[] } {
  return {
    file: binary || "aio-review",
    args: [
      `--project=${projectId}`,
      `--box=${boxId}`,
      ...(machineId ? [`--machine=${machineId}`] : []),
    ],
  };
}

/**
 * True for a machine ID the Boxes app passes to the review app: the
 * characters the hub's machine IDs and the `local` and `hub` names use.
 */
export function isMachineIdArg(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}

/** Environment variables that hold a secret and never reach a spawned process. */
export const SECRET_ENV: readonly string[] = ["AIO_SERVER_TOKEN"];

/**
 * A copy of `env` for a process this app spawns, such as a terminal or the
 * review app, without the variables in `SECRET_ENV`. The review app reads
 * the token from its file instead.
 */
export function childEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const copy = { ...env };
  for (const name of SECRET_ENV) delete copy[name];
  return copy;
}

// ---------------------------------------------------------------------------
// Permissions and the tray

/**
 * The web permissions the page may use: writing and reading the clipboard,
 * for Copy and Paste in the terminal. Everything else, such as media,
 * geolocation, and notifications, is refused.
 */
export const ALLOWED_PERMISSIONS: readonly string[] = [
  "clipboard-sanitized-write",
  "clipboard-read",
];

/** True when the page at `url` may have `permission`: only app pages, only the allowed ones. */
export function permissionAllowed(
  permission: string,
  url: string,
  appPages: readonly string[],
): boolean {
  return ALLOWED_PERMISSIONS.includes(permission) && isAppPage(url, appPages);
}

function desktopNames(env: Record<string, string | undefined>): string[] {
  return (env.XDG_CURRENT_DESKTOP ?? "").toLowerCase().split(":");
}

/** True when `closeHidesToTray` needs the GNOME Shell extension list to decide. */
export function needsExtensionList(env: Record<string, string | undefined>): boolean {
  const override = env.AIO_CLOSE_TO_TRAY;
  if (override === "1" || override === "0") return false;
  const desktop = desktopNames(env);
  return desktop.includes("gnome") && !desktop.includes("ubuntu");
}

/**
 * Whether closing the window hides the app into the tray rather than
 * quitting. Stock GNOME has no status-icon area unless an AppIndicator
 * extension runs, so a hidden window would leave a process with no visible
 * way back. Quitting the app never stops a box: the server runs them.
 *
 * - `AIO_CLOSE_TO_TRAY=1` or `0` decides outright.
 * - A GNOME session hides to the tray only in the Ubuntu session, which
 *   ships the AppIndicator extension, or when `enabledExtensions` (the
 *   `org.gnome.shell enabled-extensions` value, or `null` when unknown)
 *   names an AppIndicator extension.
 * - Every other desktop has a tray, so the window hides to it.
 */
export function closeHidesToTray(
  env: Record<string, string | undefined>,
  enabledExtensions: string | null,
): boolean {
  const override = env.AIO_CLOSE_TO_TRAY;
  if (override === "1") return true;
  if (override === "0") return false;
  if (!needsExtensionList(env)) return true;
  return /appindicator/i.test(enabledExtensions ?? "");
}

// ---------------------------------------------------------------------------
// macOS and Windows

/** The host operating systems the app runs on, as `process.platform` names them. */
export type HostOs = "linux" | "darwin" | "win32";

/** Narrows `process.platform`, treating any other Unix as Linux. */
export function hostOsOf(platform: string): HostOs {
  return platform === "darwin" || platform === "win32" ? platform : "linux";
}

/** The app's id, which Windows uses to tie notifications to the installer's Start menu shortcut. */
export const APP_USER_MODEL_ID = "dev.aio.boxes";

/**
 * Whether the app sets the X11 window class and Wayland app_id with
 * Chromium's `--class` switch, so the desktop ties the window to
 * `aio-boxes.desktop`. Only Linux desktops read it.
 */
export function usesWindowClass(os: HostOs): boolean {
  return os === "linux";
}

/** Whether `closeHidesToTray` may ask `gsettings` for the GNOME Shell extensions. */
export function mayAskGsettings(os: HostOs, env: Record<string, string | undefined>): boolean {
  return os === "linux" && needsExtensionList(env);
}

/** A menu item that Electron fills in from its role. */
export interface RoleItem {
  role: "appMenu" | "editMenu" | "windowMenu";
}

/**
 * The application menu: none on Linux and Windows, where every shortcut is
 * a `Ctrl+Shift` chord the page handles. macOS has a menu bar whether the
 * app sets one or not, and without the Edit menu's roles Cmd+C, Cmd+V, and
 * Cmd+Q do nothing, so it gets the standard app, Edit, and Window menus.
 */
export function applicationMenuTemplate(os: HostOs): RoleItem[] | null {
  return os === "darwin"
    ? [{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]
    : null;
}

/** Quotes one argument for a POSIX shell. */
function posixQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Escapes text for a double-quoted AppleScript string. */
function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * The command that runs `argv` in a new Terminal.app window on macOS:
 * `osascript` tells Terminal to run the POSIX-quoted command line.
 */
export function macTerminalCommand(argv: readonly string[]): { file: string; args: string[] } {
  const line = argv.map(posixQuote).join(" ");
  return {
    file: "osascript",
    args: [
      "-e",
      'tell application "Terminal"',
      "-e",
      "activate",
      "-e",
      `do script ${appleScriptString(line)}`,
      "-e",
      "end tell",
    ],
  };
}

/** The `aio` arguments that attach to a box the way an external terminal request asks. */
export function cliAttachArgs(req: {
  boxId: string;
  kind: "session" | "side" | "shell";
  platform?: string;
}): string[] {
  if (req.kind === "shell") return ["box", "shell", req.boxId];
  if (req.kind === "side" && req.platform) {
    return ["box", "attach", req.boxId, "--side", req.platform];
  }
  return ["box", "attach", req.boxId];
}

/** Characters that pass through `cmd.exe` and Windows Terminal unchanged. */
const WINDOWS_SAFE = /^[A-Za-z0-9._:\\/ -]+$/;

/**
 * The command that opens a box in a new console on Windows. The server's
 * attach argv holds a bash script with `&&`, quotes, and `;`, which
 * `cmd.exe` and Windows Terminal would both parse, so the console runs the
 * `aio` CLI instead, whose arguments are plain words. Windows Terminal
 * (`wt.exe`) opens it when it's installed; otherwise `cmd.exe start` opens
 * a console window. `verbatim` means the caller must pass the arguments
 * without Node.js quoting them (`windowsVerbatimArguments`).
 *
 * Returns `null` when an argument has a character either one would parse.
 */
export function windowsTerminalCommand(
  cli: string,
  args: readonly string[],
  title: string,
  hasWindowsTerminal: boolean,
): { file: string; args: string[]; verbatim: boolean } | null {
  if (![cli, title, ...args].every((a) => WINDOWS_SAFE.test(a))) return null;
  if (hasWindowsTerminal) {
    return {
      file: "wt.exe",
      args: ["-w", "new", "new-tab", "--title", title, cli, ...args],
      verbatim: false,
    };
  }
  // cmd /s /c "start "TITLE" "CLI" ARGS": /s strips the outer quotes, and
  // start reads the first quoted word as the window title.
  const quoted = (s: string) => `"${s}"`;
  return {
    file: "cmd.exe",
    args: ["/d", "/s", "/c", quoted(`start ${quoted(title)} ${quoted(cli)} ${args.join(" ")}`)],
    verbatim: true,
  };
}

/**
 * How the Boxes app starts the review app: `AIO_REVIEW_BIN` when it's set,
 * the `aio-review` command on Linux, and the `aio-review://` link on macOS
 * and Windows, where the app is an app bundle or an installed program
 * rather than a command on PATH. The review app registers the link scheme.
 */
export function reviewLaunch(
  os: HostOs,
  link: { projectId?: string; boxId?: string; machineId?: string },
  binary: string | undefined,
): { file: string; args: string[] } | { url: string } {
  if (binary || os === "linux") {
    if (link.projectId !== undefined || link.boxId !== undefined) {
      return reviewCommand(link.projectId ?? "", link.boxId ?? "", binary, link.machineId);
    }
    return { file: binary || "aio-review", args: [] };
  }
  const query = new URLSearchParams();
  if (link.projectId) query.set("project", link.projectId);
  if (link.boxId) query.set("box", link.boxId);
  if (link.machineId) query.set("machine", link.machineId);
  const q = query.toString();
  return { url: `aio-review://launch${q ? `?${q}` : ""}` };
}
