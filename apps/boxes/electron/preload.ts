// The preload script: exposes `window.aio`, the bridge the renderer
// uses for the token, external terminals, the review app, and file pickers.
//
// A sandboxed preload can load no file of its own besides this one, so it
// imports nothing from the workspace: a module it shared with the main
// process would become a separate chunk.
import { contextBridge, ipcRenderer } from "electron";
import type { AioBridge } from "../src/bridge";

const init = ipcRenderer.sendSync("aio:init") as {
  serverUrl: string;
  remoteHub: boolean;
  appVersion: string;
};
let tokenTaken = false;

const api: AioBridge = {
  // The token never sits on the bridge: the page takes it once, trades it
  // for the session cookie, and later calls get `null`.
  takeToken: () => {
    if (tokenTaken) return null;
    tokenTaken = true;
    return ipcRenderer.sendSync("aio:token") as string | null;
  },
  serverUrl: init.serverUrl,
  appVersion: init.appVersion,
  relaunch: () => ipcRenderer.send("aio:relaunch"),
  remoteHub: init.remoteHub,
  openExternalTerminal: (req) => ipcRenderer.invoke("aio:open-external-terminal", req),
  launchReview: (req) => ipcRenderer.invoke("aio:launch-review", req),
  pickDirectory: (defaultPath) => ipcRenderer.invoke("aio:pick-directory", defaultPath),
  readClipboardText: () => ipcRenderer.invoke("aio:read-clipboard-text"),
  openPath: (path) => ipcRenderer.invoke("aio:open-path", path),
  openExternal: (url) => ipcRenderer.invoke("aio:open-external", url),
  onSelectBox: (listener) => {
    const handler = (_e: unknown, boxId: string, machineId?: string, notificationId?: string) =>
      listener(boxId, machineId, notificationId);
    ipcRenderer.on("aio:select-box", handler);
    return () => ipcRenderer.removeListener("aio:select-box", handler);
  },
  notify: (n) => ipcRenderer.send("aio:notify", n),
  notifyBuild: (n) => ipcRenderer.send("aio:notify-build", n),
  onSelectBuild: (listener) => {
    const handler = (_e: unknown, buildId: string, machineId: string) =>
      listener(buildId, machineId);
    ipcRenderer.on("aio:select-build", handler);
    return () => ipcRenderer.removeListener("aio:select-build", handler);
  },
  quit: () => ipcRenderer.send("aio:quit"),
};

contextBridge.exposeInMainWorld("aio", api);
