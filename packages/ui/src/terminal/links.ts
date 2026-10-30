// Opens the links a terminal pane shows: plain URLs that the web-links addon
// finds, and OSC 8 hyperlinks that a program writes.
import type { ILinkHandler } from "@xterm/xterm";

/** Reports whether a terminal link can be opened. Only http and https links can. */
export function isOpenableLink(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Opens `url` with `open`, or in a new window with no opener when `open` is
 * absent. The URL goes straight to `window.open`, so an Electron window-open
 * handler sees the real URL.
 */
export function openTerminalLink(url: string, open?: (url: string) => void): void {
  if (!isOpenableLink(url)) return;
  if (open) open(url);
  else window.open(url, "_blank", "noopener");
}

/**
 * The xterm.js handler for OSC 8 hyperlinks. Without one, xterm.js opens
 * `about:blank` and then sets its location, which an Electron window-open
 * handler that allows only http and https denies, so the link does nothing.
 */
export function oscLinkHandler(open: () => ((url: string) => void) | undefined): ILinkHandler {
  return { activate: (_event, uri) => openTerminalLink(uri, open()) };
}
