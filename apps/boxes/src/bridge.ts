// The optional Electron bridge. The preload script puts it on
// `window.agentbox`; in a plain browser it is absent, and the app falls back
// to browser behavior for each call.
import type { Platform } from "@agentbox/contracts";

export interface ExternalTerminalRequest {
  boxId: string;
  kind: "session" | "side" | "shell";
  platform?: Platform;
}

export interface BridgeResult {
  ok: boolean;
  error?: string;
}

export interface AgentBoxBridge {
  /**
   * Returns the server's bearer token, which the main process reads from
   * `server.token` in the data directory, on the first call, and `null` on
   * every later one. The page trades it for the session cookie at start.
   */
  takeToken: () => string | null;
  /** The server origin, such as `https://127.0.0.1:21400`. */
  serverUrl: string;
  /** Opens a host terminal attached to a box, through the attach-command route. */
  openExternalTerminal: (req: ExternalTerminalRequest) => Promise<BridgeResult>;
  /** Launches `agentbox-review` with the launcher prefilled. */
  launchReview: (req: { projectId: string; boxId: string }) => Promise<BridgeResult>;
  pickDirectory: (defaultPath?: string) => Promise<string | null>;
  openPath: (path: string) => Promise<BridgeResult>;
  openExternal: (url: string) => Promise<BridgeResult>;
  /** Calls `listener` with the box id when a notification is clicked. */
  onSelectBox: (listener: (boxId: string) => void) => () => void;
  quit: () => void;
}

declare global {
  interface Window {
    agentbox?: AgentBoxBridge;
  }
}

/** The bridge, or `undefined` in a plain browser. */
export function bridge(): AgentBoxBridge | undefined {
  return typeof window !== "undefined" ? window.agentbox : undefined;
}
