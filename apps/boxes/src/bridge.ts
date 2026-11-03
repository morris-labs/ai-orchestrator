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
  /**
   * True when the app controls an enrolled hub on another PC, so the server's
   * files and containers aren't on this PC.
   */
  remoteHub?: boolean;
  /** Opens a host terminal attached to a box, through the attach-command route. */
  openExternalTerminal: (req: ExternalTerminalRequest) => Promise<BridgeResult>;
  /**
   * Launches `aio-review` with the launcher prefilled. `machineId` names
   * the machine that holds the box; absent means this one.
   */
  launchReview: (req: {
    projectId: string;
    boxId: string;
    machineId?: string;
  }) => Promise<BridgeResult>;
  pickDirectory: (defaultPath?: string) => Promise<string | null>;
  /** Returns the plain text on the system clipboard, or an empty string. */
  readClipboardText: () => Promise<string>;
  openPath: (path: string) => Promise<BridgeResult>;
  openExternal: (url: string) => Promise<BridgeResult>;
  /** Calls `listener` with the box id when a notification is clicked. */
  onSelectBox: (
    listener: (boxId: string, machineId?: string, notificationId?: string) => void,
  ) => () => void;
  /**
   * Raises a desktop notification for a box on another machine, whose events
   * the main process doesn't watch. A click selects the box, through
   * `onSelectBox`, with the machine and notification ids.
   */
  notify?: (n: {
    title: string;
    body: string;
    urgent: boolean;
    boxId: string;
    machineId: string;
    notificationId: string;
  }) => void;
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
