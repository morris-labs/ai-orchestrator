// Reads a Claude Code screen, as `tmux capture-pane -p -e` prints it, to tell
// whether the session can take a typed message. A line typed while Claude
// Code shows a dialog is dropped, and the Enter after it answers the dialog:
// it can exit the session at the trust dialog, answer a question for the
// agent, or approve a pending tool call. See
// `docs/build-pipeline/vendor-cli-facts.md`.
//
// Claude Code draws its input box as a prompt line (`❯` or `>`) between two
// horizontal rules, with a footer below; the upper rule can carry a label.
// A dialog replaces the input box and lists its options with a `❯` beside
// the selected one, such as `❯ 1. Yes`. A busy session still shows the
// input box, and a line typed there queues as the next turn, which is safe.
//
// An empty input box can show dim text that nobody typed: the start-up
// placeholder, or a suggested next prompt after a turn ends. The capture
// keeps its styles (`-e`), so the reader can drop dim text from the prompt
// line. A capture without styles still reads, but a suggestion in it looks
// like a draft.

export type ClaudeInputState =
  /** The input box is empty: a typed line starts a turn, or queues for the next one. */
  | { state: "ready" }
  /** A dialog shows: typing would be lost, and Enter would answer the dialog. */
  | { state: "dialog"; reason: string }
  /** The input box holds text that a person typed and didn't send. */
  | { state: "draft"; reason: string }
  /** No input box shows, such as while the session starts or after it exited. */
  | { state: "unknown"; reason: string };

/** A horizontal rule; the one above the input box can end with a label, such as the session name. */
const RULE = /^[╭╰]?[─━]{8,}/;
const PROMPT = /^[❯>]\s?(.*)$/;
const OPTION = /^[❯›>]\s*\d+\.\s/;
const DIALOG_TEXT = [
  /Do you want to /,
  /Do you trust the files/,
  /Enter to (select|confirm)/,
  /Esc to cancel/,
];

// eslint-disable-next-line no-control-regex
const SGR = /\u001b\[([0-9;]*)m/g;
// A CSI sequence, such as SGR, or an OSC sequence, such as a hyperlink.
// eslint-disable-next-line no-control-regex
const ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** `text` without its escape sequences, as `tmux capture-pane -p -e` keeps them. */
export function stripEscapes(text: string): string {
  return text.replace(ESCAPE, "");
}

/**
 * The text of `line` that shows at normal intensity: the line without its
 * escape sequences and without the runs that SGR 2 (dim) styles.
 */
function undimmed(line: string): string {
  let out = "";
  let dim = false;
  let at = 0;
  for (const match of line.matchAll(SGR)) {
    if (!dim) out += line.slice(at, match.index);
    at = match.index + match[0].length;
    for (const code of (match[1] || "0").split(";")) {
      if (code === "2") dim = true;
      else if (code === "0" || code === "" || code === "22") dim = false;
    }
  }
  if (!dim) out += line.slice(at);
  return out.replace(ESCAPE, "");
}

/** A line without the box borders of the old input style and without surrounding spaces. */
function normalize(line: string): string {
  return line
    .replace(/^\s*│/, "")
    .replace(/│\s*$/, "")
    .replace(/^\s+|\s+$/g, "");
}

function isDialogLine(line: string): boolean {
  return OPTION.test(line) || DIALOG_TEXT.some((re) => re.test(line));
}

/** Whether Claude Code's screen `screen` can take a typed message. */
export function claudeInputState(screen: string): ClaudeInputState {
  const raw = screen.split("\n");
  const lines = raw.map((line) => normalize(stripEscapes(line)));
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  let prompt = -1;
  for (let i = lines.length - 2; i >= 1; i--) {
    const line = lines[i] as string;
    if (
      PROMPT.test(line) &&
      !OPTION.test(line) &&
      RULE.test(lines[i - 1] as string) &&
      RULE.test(lines[i + 1] as string)
    ) {
      prompt = i;
      break;
    }
  }
  if (prompt < 0) {
    if (lines.slice(-30).some(isDialogLine)) {
      return { state: "dialog", reason: "The session shows a dialog." };
    }
    return { state: "unknown", reason: "The session doesn't show Claude Code's input box." };
  }
  // The live area above the input box, back to the rule before it, and the
  // footer below, must not hold a dialog's options.
  const live: string[] = [];
  for (let i = prompt - 2; i >= 0 && i >= prompt - 16 && !RULE.test(lines[i] as string); i--) {
    live.push(lines[i] as string);
  }
  if ([...live, ...lines.slice(prompt + 2)].some((l) => OPTION.test(l))) {
    return { state: "dialog", reason: "The session shows a dialog beside its input box." };
  }
  const text = (PROMPT.exec(normalize(undimmed(raw[prompt] as string)))?.[1] ?? "").trim();
  if (text === "" || text.startsWith('Try "')) return { state: "ready" };
  return { state: "draft", reason: "The input box holds text that nobody sent yet." };
}

/**
 * A line that Claude Code draws above its input box while a turn runs: a
 * spinner sign and an active verb that ends in an ellipsis, such as
 * `✶ Pondering…`, or the wait for background agents. A finished turn leaves
 * a line in the past tense, such as `✻ Worked for 6m 6s`, which doesn't match.
 */
const SPINNER = /^[·✢✳✶✻✽*]\s+(?:\S.*…|Waiting for .* to finish)/;
const INTERRUPT = /esc to interrupt/i;

/**
 * Whether Claude Code's screen `screen` shows a turn under way, from the
 * spinner line above the input box or the interrupt hint. A session that
 * shows no input box reads as not busy; `claudeInputState` tells why it
 * can't take a message.
 */
export function claudeSessionBusy(screen: string): boolean {
  const lines = screen.split("\n").map((line) => normalize(stripEscapes(line)));
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  let prompt = -1;
  for (let i = lines.length - 2; i >= 1; i--) {
    const line = lines[i] as string;
    if (
      PROMPT.test(line) &&
      RULE.test(lines[i - 1] as string) &&
      RULE.test(lines[i + 1] as string)
    ) {
      prompt = i;
      break;
    }
  }
  if (prompt < 0) return false;
  const near: string[] = lines.slice(prompt + 2);
  for (let i = prompt - 2; i >= 0 && i >= prompt - 16 && !RULE.test(lines[i] as string); i--) {
    near.push(lines[i] as string);
  }
  return near.some((line) => SPINNER.test(line) || INTERRUPT.test(line));
}
