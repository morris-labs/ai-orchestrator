// Exposes the server URL and, once, the token to the renderer, and forwards
// navigation requests from the tray and notifications. The token stays out
// of the command line, the page's URL, and `window.agentbox`.
import type * as Electron from "electron";

// A sandboxed preload is CommonJS, so it loads Electron with `require`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron") as typeof Electron;

const config = ipcRenderer.sendSync("agentbox:config") as { serverUrl: string | null };
let tokenTaken = false;

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
    const handler = (_e: unknown, hash: string) => listener(hash);
    ipcRenderer.on("agentbox:navigate", handler);
    return () => ipcRenderer.removeListener("agentbox:navigate", handler);
  },
});
