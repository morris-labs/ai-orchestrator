// The optional Electron bridge. The preload script puts it on
// `window.aio`; in a plain browser it is absent, and the app falls back
// to browser behavior for each call.
import type { Platform } from "@aio/contracts";

export interface ExternalTerminalRequest {
  boxId: string;
  kind: "session" | "side" | "shell";
  platform?: Platform;
}

export interface BridgeResult {
  ok: boolean;
  error?: string;
}

export interface AioBridge {
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
  /** Launches `aio-review` with the launcher prefilled. */
  launchReview: (req: { projectId: string; boxId: string }) => Promise<BridgeResult>;
  pickDirectory: (defaultPath?: string) => Promise<string | null>;
  /** Returns the plain text on the system clipboard, or an empty string. */
  readClipboardText: () => Promise<string>;
  openPath: (path: string) => Promise<BridgeResult>;
  openExternal: (url: string) => Promise<BridgeResult>;
  /** Calls `listener` with the box id when a notification is clicked. */
  onSelectBox: (listener: (boxId: string) => void) => () => void;
  quit: () => void;
}

declare global {
  interface Window {
    aio?: AioBridge;
  }
}

/** The bridge, or `undefined` in a plain browser. */
export function bridge(): AioBridge | undefined {
  return typeof window !== "undefined" ? window.aio : undefined;
}
