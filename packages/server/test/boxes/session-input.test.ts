// Reading a Claude Code screen before typing into it: typing into a dialog
// drops the text, and Enter answers the dialog, even approving a tool call
// (docs/build-pipeline/vendor-cli-facts.md).
import { describe, expect, it } from "vitest";
import { claudeInputState } from "../../src/boxes/session-input.js";

const RULE = "─".repeat(80);
/** Claude Code puts a no-break space after its prompt sign. */
const NBSP = String.fromCharCode(0xa0);

/** A Claude Code screen: some transcript, then the input box and its footer. */
function screen(
  input: string,
  above: string[] = ["● Done."],
  footer = "  ? for shortcuts",
): string {
  return [...above, "", RULE, input, RULE, footer, ""].join("\n");
}

describe("claudeInputState", () => {
  it("reads an empty input box as ready", () => {
    expect(claudeInputState(screen(`❯${NBSP}`))).toEqual({ state: "ready" });
    expect(claudeInputState(screen("> "))).toEqual({ state: "ready" });
  });

  it("reads an input box whose upper rule carries a label", () => {
    const labelled = ["● Done.", "", `${"─".repeat(60)} Shop [main] ─`, `❯${NBSP}`, RULE, ""].join(
      "\n",
    );
    expect(claudeInputState(labelled)).toEqual({ state: "ready" });
  });

  it("reads a busy session that still shows its input box as ready, since a typed line queues", () => {
    const busy = screen(
      `❯${NBSP}`,
      ["✻ Waiting for 3 background agents to finish"],
      "  ⏵⏵ auto mode on",
    );
    expect(claudeInputState(busy)).toEqual({ state: "ready" });
  });

  it("reads the start-up placeholder as an empty input box", () => {
    expect(claudeInputState(screen(`❯${NBSP}Try "refactor cart.mjs"`))).toEqual({
      state: "ready",
    });
  });

  it("refuses an input box that holds the owner's unsent text", () => {
    expect(claudeInputState(screen(`❯${NBSP}keep both behaviours, continue`))).toMatchObject({
      state: "draft",
    });
  });

  it("refuses a tool permission dialog", () => {
    const dialog = [
      "● Bash(rm -rf build)",
      "",
      RULE,
      " Bash command",
      "",
      "   rm -rf build",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again for rm commands",
      "   3. No, and tell Claude what to do differently (esc)",
      "",
    ].join("\n");
    expect(claudeInputState(dialog)).toMatchObject({ state: "dialog" });
  });

  it("refuses a question dialog and the workspace trust dialog", () => {
    const question = [
      RULE,
      " Which store should the cart use?",
      "",
      " ❯ 1. Memory",
      "   2. File",
      "",
      " Enter to select · ↑/↓ to navigate · Esc to cancel",
      "",
    ].join("\n");
    expect(claudeInputState(question)).toMatchObject({ state: "dialog" });
    const trust = [
      "╭──────────────────────────────────────────╮",
      "│ Do you trust the files in this folder?    │",
      "│                                           │",
      "│ ❯ 1. Yes, proceed                         │",
      "│   2. No, exit                             │",
      "╰──────────────────────────────────────────╯",
    ].join("\n");
    expect(claudeInputState(trust)).toMatchObject({ state: "dialog" });
  });

  it("refuses a screen without an input box, such as a shell or a session still starting", () => {
    expect(claudeInputState("prime@box:~/shop$ \n")).toMatchObject({ state: "unknown" });
    expect(claudeInputState("")).toMatchObject({ state: "unknown" });
  });

  it("reads the old boxed input style", () => {
    const boxed = [
      "╭──────────────────────────────────────────╮",
      "│ >                                         │",
      "╰──────────────────────────────────────────╯",
      "  ? for shortcuts",
    ].join("\n");
    expect(claudeInputState(boxed)).toEqual({ state: "ready" });
  });
});
