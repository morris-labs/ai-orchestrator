// What a terminal pane does with a key before xterm.js sees it.
import { isApplicationChord, eventKey, type KeyLike } from "../keys/chords";

export type TerminalKeyAction = "copy" | "paste" | "application" | "terminal";

/**
 * Decides who handles a key: `Ctrl+Shift+C` copies and `Ctrl+Shift+V` pastes
 * inside the pane, other application chords go to the window, and every
 * other key goes to the program in the terminal.
 */
export function classifyTerminalKey(e: KeyLike): TerminalKeyAction {
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey) {
    const k = eventKey(e);
    if (k === "C") return "copy";
    if (k === "V") return "paste";
  }
  return isApplicationChord(e) ? "application" : "terminal";
}

/** The disconnected banner text, as the Qt `TerminalWidget` drew it. */
export function endedBanner(
  exitCode: number | null,
  subject = "This box is no longer attached.",
): string {
  const head = exitCode === null ? "Session ended." : `Session ended (exit ${exitCode}).`;
  return `${head}\n${subject}`;
}

/**
 * The xterm.js custom key handler: copy and paste run here, application
 * chords go to the window, and every other key goes to the terminal.
 * xterm.js ignores the handler's return value for the DOM event, so this
 * cancels the browser's default itself; otherwise Chromium's own Ctrl+Shift+V
 * paste would fire a `paste` event that xterm.js pastes a second time.
 * Returns what xterm.js expects: true to let the terminal handle the key.
 */
export function handleTerminalKey(
  e: KeyLike & { type: string; preventDefault(): void },
  actions: { copy: () => void; paste: () => void },
): boolean {
  if (e.type !== "keydown") return true;
  const action = classifyTerminalKey(e);
  if (action === "terminal") return true;
  e.preventDefault();
  if (action === "copy") actions.copy();
  if (action === "paste") actions.paste();
  return false;
}
