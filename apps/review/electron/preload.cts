// Exposes the server URL and token to the renderer, and forwards navigation
// requests from the tray and notifications. The token stays out of the
// command line and the page's URL.
import type * as Electron from "electron";

// A sandboxed preload is CommonJS, so it loads Electron with `require`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require("electron") as typeof Electron;

const config = ipcRenderer.sendSync("agentbox:config") as {
  token: string | null;
  serverUrl: string | null;
};

contextBridge.exposeInMainWorld("agentbox", {
  token: config.token,
  serverUrl: config.serverUrl,
  onNavigate(listener: (hash: string) => void) {
    const handler = (_e: unknown, hash: string) => listener(hash);
    ipcRenderer.on("agentbox:navigate", handler);
    return () => ipcRenderer.removeListener("agentbox:navigate", handler);
  },
});
