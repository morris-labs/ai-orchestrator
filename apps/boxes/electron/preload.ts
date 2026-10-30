// The preload script: exposes `window.agentbox`, the bridge the renderer
// uses for the token, external terminals, the review app, and file pickers.
//
// A sandboxed preload can load no file of its own besides this one, so it
// imports nothing from the workspace: a module it shared with the main
// process would become a separate chunk.
import { contextBridge, ipcRenderer } from "electron";
import type { AgentBoxBridge } from "../src/bridge";

const init = ipcRenderer.sendSync("agentbox:init") as { serverUrl: string };
let tokenTaken = false;

const api: AgentBoxBridge = {
  // The token never sits on the bridge: the page takes it once, trades it
  // for the session cookie, and later calls get `null`.
  takeToken: () => {
    if (tokenTaken) return null;
    tokenTaken = true;
    return ipcRenderer.sendSync("agentbox:token") as string | null;
  },
  serverUrl: init.serverUrl,
  openExternalTerminal: (req) => ipcRenderer.invoke("agentbox:open-external-terminal", req),
  launchReview: (req) => ipcRenderer.invoke("agentbox:launch-review", req),
  pickDirectory: (defaultPath) => ipcRenderer.invoke("agentbox:pick-directory", defaultPath),
  openPath: (path) => ipcRenderer.invoke("agentbox:open-path", path),
  openExternal: (url) => ipcRenderer.invoke("agentbox:open-external", url),
  onSelectBox: (listener) => {
    const handler = (_e: unknown, boxId: string) => listener(boxId);
    ipcRenderer.on("agentbox:select-box", handler);
    return () => ipcRenderer.removeListener("agentbox:select-box", handler);
  },
  quit: () => ipcRenderer.send("agentbox:quit"),
};

contextBridge.exposeInMainWorld("agentbox", api);
