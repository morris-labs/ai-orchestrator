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
