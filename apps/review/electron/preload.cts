// Exposes the server URL and, once, the token to the renderer, and forwards
// navigation requests from the tray and notifications. The token stays out
// of the command line, the page's URL, and `window.agentbox`.
import type * as Electron from "electron";

// A sandboxed preload is CommonJS, so it loads Electron with `require`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron") as typeof Electron;

const config = ipcRenderer.sendSync("agentbox:config") as { serverUrl: string | null };
let tokenTaken = false;

// The page subscribes in an effect, after it renders; a navigation that
// arrives before then waits here instead of being lost.
let navigateListener: ((hash: string) => void) | null = null;
let pendingHash: string | null = null;
ipcRenderer.on("agentbox:navigate", (_e: unknown, hash: string) => {
  if (navigateListener) navigateListener(hash);
  else pendingHash = hash;
});

contextBridge.exposeInMainWorld("agentbox", {
  // The page takes the token once, trades it for the session cookie, and
  // later calls get `null`.
  takeToken(): string | null {
    if (tokenTaken) return null;
    tokenTaken = true;
    return ipcRenderer.sendSync("agentbox:token") as string | null;
  },
  serverUrl: config.serverUrl,
  onNavigate(listener: (hash: string) => void) {
    navigateListener = listener;
    if (pendingHash !== null) {
      const hash = pendingHash;
      pendingHash = null;
      listener(hash);
    }
    return () => {
      if (navigateListener === listener) navigateListener = null;
    };
  },
});
