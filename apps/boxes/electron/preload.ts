// The preload script: exposes `window.agentbox`, the bridge the renderer
// uses for the token, external terminals, the review app, and file pickers.
import { contextBridge, ipcRenderer } from "electron";
import type { AgentBoxBridge } from "../src/bridge";

const init = ipcRenderer.sendSync("agentbox:init") as { token: string | null; serverUrl: string };

const api: AgentBoxBridge = {
  token: init.token,
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
