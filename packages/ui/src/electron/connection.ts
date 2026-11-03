// The local or hub connection setting of an Electron app: the setting's window,
// and what an app does at startup. Node.js only: import it from
// `@aio/ui/electron-main`, never from page code.
//
// The window is one generated page with no script and no bridge. A form on it
// navigates to `aio-connection://ACTION`, and the main process cancels that
// navigation and reads the fields, so the page never holds anything but what
// the user types.
import {
  enrollWithHub,
  forgetHub,
  readConnection,
  setConnectionMode,
  startHubProxy,
  takeInstallerEnrollment,
  type GuiConnection,
  type HubProxy,
} from "@aio/contracts/gui-client";

export { guiClientDir } from "@aio/contracts/gui-client";

/** The argument that opens the connection window. */
export const CONNECTION_ARG = "--connection";

export type ConnectionAction =
  | { action: "enroll"; hubUrl: string; code: string; name: string }
  | { action: "local" }
  | { action: "hub" }
  | { action: "forget" };

/** Reads a form's navigation, or returns `null` for any other URL. */
export function parseConnectionAction(url: string): ConnectionAction | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "aio-connection:") return null;
  const action = parsed.hostname;
  if (action === "local" || action === "hub" || action === "forget") return { action };
  if (action !== "enroll") return null;
  return {
    action,
    hubUrl: (parsed.searchParams.get("hubUrl") ?? "").trim(),
    code: (parsed.searchParams.get("code") ?? "").trim(),
    name: (parsed.searchParams.get("name") ?? "").trim(),
  };
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/** The window's page as a `data:` URL. */
export function connectionPageUrl(
  connection: GuiConnection,
  defaultName: string,
  notice: string | null,
): string {
  const hub = connection.hub;
  const button = (action: string, label: string) =>
    `<form action="aio-connection://${action}"><button>${label}</button></form>`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action aio-connection:">
<title>Connection</title><style>
body{font:14px system-ui,sans-serif;background:#1b1c1e;color:#e6e6e6;margin:24px}
label{display:block;margin:10px 0 4px}input{width:100%;box-sizing:border-box;padding:6px}
button{margin:12px 8px 0 0;padding:6px 12px}form{display:inline-block}form.wide{display:block}
.notice{color:#ffb86b}
</style></head><body>
<h2>Connection</h2>
${notice ? `<p class="notice" role="alert">${escapeHtml(notice)}</p>` : ""}
<p>This app uses ${
    connection.mode === "hub" && hub
      ? `the hub at <b>${escapeHtml(hub.hubUrl)}</b>, as <b>${escapeHtml(hub.name)}</b>`
      : "the local server on this PC"
  }. A change restarts the app.</p>
${connection.mode === "hub" ? button("local", "Use Local Server") : ""}
${connection.mode === "local" && hub ? button("hub", `Use Hub ${escapeHtml(hub.hubUrl)}`) : ""}
${hub ? button("forget", "Remove Enrollment") : ""}
<h3>Enroll with a hub</h3>
<p>On the hub, run <code>aio gui code</code>, or click <b>Add GUI App</b> on the Machines page.</p>
<form class="wide" action="aio-connection://enroll" autocomplete="off">
<label for="hubUrl">Hub URL</label><input id="hubUrl" name="hubUrl" required placeholder="https://hub.example.com:21403">
<label for="code">Code</label><input id="code" name="code" required>
<label for="name">Name of this PC</label><input id="name" name="name" required value="${escapeHtml(defaultName)}">
<button>Enroll</button></form>
</body></html>`;
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html).toString("base64")}`;
}

/** What an app needs from Electron for the window. */
export interface ConnectionWindowHost {
  /** Makes a window with no preload, no Node.js, and a sandbox, and returns it. */
  createWindow(): {
    loadURL(url: string): Promise<void>;
    webContents: {
      on(
        event: "will-navigate",
        listener: (e: { url: string; preventDefault(): void }) => void,
      ): void;
    };
  };
  /** Restarts the app, so the setting takes effect. */
  relaunch(): void;
}

/** Opens the connection window for the enrollment in `dir`. */
export function openConnectionWindow(
  host: ConnectionWindowHost,
  dir: string,
  defaultName: string,
  notice: string | null = null,
): void {
  const win = host.createWindow();
  const show = (message: string | null) =>
    void win.loadURL(connectionPageUrl(readConnection(dir), defaultName, message));
  win.webContents.on("will-navigate", (e) => {
    e.preventDefault();
    const action = parseConnectionAction(e.url);
    if (!action) return;
    void applyConnectionAction(dir, action).then(
      () => host.relaunch(),
      (err: unknown) => show(err instanceof Error ? err.message : String(err)),
    );
  });
  show(notice);
}

async function applyConnectionAction(dir: string, action: ConnectionAction): Promise<void> {
  if (action.action === "enroll") await enrollWithHub(dir, action);
  else if (action.action === "forget") forgetHub(dir);
  else setConnectionMode(dir, action.action);
}

/**
 * What an app does at startup: enrolls with a code that an installer left, and
 * starts the proxy when the setting is hub. Returns the proxy, or `null` for
 * the local server, and a notice for the user when something failed.
 */
export async function prepareConnection(
  dir: string,
  defaultName: string,
): Promise<{ proxy: HubProxy | null; notice: string | null }> {
  let notice: string | null = null;
  const pending = takeInstallerEnrollment(dir);
  if (pending) {
    try {
      await enrollWithHub(dir, { name: defaultName, ...pending });
    } catch (err) {
      notice = `The enrollment from the installer failed: ${(err as Error).message}`;
    }
  }
  const connection = readConnection(dir);
  if (connection.mode !== "hub" || !connection.hub) return { proxy: null, notice };
  try {
    return { proxy: await startHubProxy(connection.hub), notice };
  } catch (err) {
    return {
      proxy: null,
      notice: `Can't start the connection to the hub: ${(err as Error).message}`,
    };
  }
}
