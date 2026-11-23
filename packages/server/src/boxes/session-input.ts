// Reads a Claude Code screen, as `tmux capture-pane -p` prints it, to tell
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
  const lines = screen.split("\n").map(normalize);
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
  const text = (PROMPT.exec(lines[prompt] as string)?.[1] ?? "").trim();
  if (text === "" || text.startsWith('Try "')) return { state: "ready" };
  return { state: "draft", reason: "The input box holds text that nobody sent yet." };
}
