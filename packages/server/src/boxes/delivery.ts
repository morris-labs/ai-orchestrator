// Typing a message into a box's interactive session without answering a
// dialog. The facts behind each step are in
// `docs/build-pipeline/vendor-cli-facts.md`:
//
// - A line typed while Claude Code shows a dialog is dropped, and the Enter
//   after it answers the dialog, even approving a tool call. So for a Claude
//   Code session, the server reads the screen first and types only when the
//   input box shows and is empty. The server can't read a Codex or Copilot
//   session's screen, so it types nothing into one.
// - Text and Enter in one fast `send-keys` call can read as a paste, which
//   turns Enter into a line break. So Enter goes in its own call after a
//   pause.
// - An idle Claude Code session can show a suggested next prompt, dim, in
//   its empty input box. So the server captures the screen with its styles
//   and reads dim prompt text as empty; see `session-input.ts`.
// - Claude Code records each message it takes in the session's transcript,
//   including one that queues behind a busy turn. So the server confirms a
//   delivery there. A message whose marker the transcript holds is never
//   typed twice. A message without a marker can repeat earlier text, such as
//   a hold or a usage alert, so it's always typed, and only a new copy of
//   its text in the transcript confirms it.
// - A message can ask for a cleared session, such as the Project manager's
//   milestone hand-off. Claude Code's `/clear` starts a fresh conversation
//   with a new session ID, so the server clears only an idle session, waits
//   for the input box to show again, and reads the transcript from the box's
//   record each time, which the session watcher updates to the new ID.
import type { Platform } from "@aio/contracts";
import { claudeInputState, claudeSessionBusy, stripEscapes } from "./session-input.js";

/** How long delivery waits, in milliseconds. */
export interface DeliveryTiming {
  /** Between the text and its Enter. Default: 500. */
  pauseMs?: number;
  /** For the transcript to show the message. Default: 10,000. */
  confirmMs?: number;
  /** Between transcript reads. Default: 250. */
  pollMs?: number;
}

/** What delivery needs from the box: tmux in its container, and its transcript. */
export interface DeliveryTarget {
  platform: Platform;
  /** Runs a tmux command in the box's container and returns its standard output; throws on failure. */
  tmux(args: string[]): Promise<string>;
  /** The session's transcript as text, or `null` when the server doesn't know where it is. */
  transcript(): Promise<string | null>;
}

export interface DeliveryRequest {
  text: string;
  /**
   * A string that appears in this message and nowhere else, such as an inbox
   * item's marker. A transcript that holds it already means the message
   * arrived, so it isn't typed again. Without a marker, the message is
   * always typed, and the transcript confirms it when it holds one more
   * copy of the text than it did before.
   */
  marker?: string;
  /**
   * Clears the session before the message: Claude Code's `/clear` starts a
   * fresh conversation. The server clears only an idle session, so a busy
   * one makes the message wait.
   */
  clear?: boolean;
}

export type DeliveryResult =
  /**
   * The message was typed. `confirmed` is true when the transcript shows it,
   * false when it didn't in time, and `null` when the server has no
   * transcript to read.
   */
  | { delivered: true; confirmed: boolean | null }
  /**
   * Nothing was typed: the session can't take a message now. `stopped`
   * marks a box that isn't running, and `unsupported` a session that never
   * takes one, since it doesn't run Claude Code.
   */
  | { delivered: false; reason: string; stopped?: true; unsupported?: true };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The form a string takes inside a JSON string, as transcript lines hold it. */
function inJson(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

/** How many times the transcript holds `marker`, or `null` without a transcript. */
async function count(target: DeliveryTarget, marker: string): Promise<number | null> {
  const transcript = await target.transcript();
  if (transcript === null) return null;
  const needle = inJson(marker);
  let n = 0;
  for (let at = transcript.indexOf(needle); at !== -1; at = transcript.indexOf(needle, at + 1)) {
    n += 1;
  }
  return n;
}

/** Waits up to `ms` for the transcript to hold `marker` more than `before` times. */
async function confirm(
  target: DeliveryTarget,
  marker: string,
  before: number,
  ms: number,
  pollMs: number,
): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (((await count(target, marker)) ?? 0) > before) return true;
    if (Date.now() >= end) return false;
    await sleep(pollMs);
  }
}

/**
 * Clears an idle Claude Code session that shows its empty input box, as
 * `screen` captured it: types `/clear`, sends Enter on its own, and waits
 * for the input box to show again, empty and idle. Returns true once the
 * session is ready for the next message, or the reason it isn't.
 */
async function clearSession(
  target: DeliveryTarget,
  screen: string,
  timing: DeliveryTiming,
): Promise<true | string> {
  // `/clear` while a turn runs would cut the turn short, so a busy session waits.
  if (claudeSessionBusy(screen)) {
    return "The session is busy, and the server clears a session only while it's idle.";
  }
  await target.tmux(["send-keys", "-l", "--", "/clear"]);
  await sleep(timing.pauseMs ?? 500);
  await target.tmux(["send-keys", "Enter"]);
  const waitMs = timing.confirmMs ?? 10_000;
  let end = Date.now() + waitMs;
  let enterAgain = true;
  for (;;) {
    const now = await target.tmux(["capture-pane", "-p", "-e"]);
    const state = claudeInputState(now);
    if (state.state === "ready" && !claudeSessionBusy(now)) return true;
    if (Date.now() >= end) {
      // Enter that read as part of a paste leaves `/clear` in the input
      // box: the input box is ours then, so one more Enter sends it.
      if (enterAgain && state.state === "draft" && stripEscapes(now).includes("/clear")) {
        enterAgain = false;
        await target.tmux(["send-keys", "Enter"]);
        end = Date.now() + waitMs;
        continue;
      }
      return `The session didn't show its empty input box after /clear: ${
        state.state === "ready" ? "it's busy." : state.reason
      }`;
    }
    await sleep(timing.pollMs ?? 250);
  }
}

/**
 * Types `request.text` into a Claude Code session and presses Enter, only
 * when the input box shows and is empty, and confirms the message from the
 * transcript. Refuses every other session.
 */
export async function deliverToSession(
  target: DeliveryTarget,
  request: DeliveryRequest,
  timing: DeliveryTiming = {},
): Promise<DeliveryResult> {
  const marker = request.marker ?? request.text;
  if (target.platform !== "claude") {
    return {
      delivered: false,
      unsupported: true,
      reason: `The session runs ${target.platform}, whose screen the server can't read, so the server types nothing into it.`,
    };
  }
  // A marker names one message, so any copy of it means this one arrived.
  // Text alone can repeat, so only a copy beyond the ones there now counts.
  const seen = (await count(target, marker)) ?? 0;
  if (request.marker !== undefined && seen > 0) return { delivered: true, confirmed: true };
  let before = request.marker !== undefined ? 0 : seen;
  const start = await target.tmux(["capture-pane", "-p", "-e"]);
  const input = claudeInputState(start);
  if (input.state !== "ready") return { delivered: false, reason: input.reason };
  if (request.clear) {
    const cleared = await clearSession(target, start, timing);
    if (cleared !== true) return { delivered: false, reason: cleared };
    // The fresh session has a transcript of its own.
    if (request.marker === undefined) before = (await count(target, marker)) ?? 0;
  }
  // `--` keeps a message that starts with `-` from being read as flags.
  await target.tmux(["send-keys", "-l", "--", request.text]);
  await sleep(timing.pauseMs ?? 500);
  await target.tmux(["send-keys", "Enter"]);
  if ((await target.transcript()) === null) return { delivered: true, confirmed: null };
  const pollMs = timing.pollMs ?? 250;
  const confirmMs = timing.confirmMs ?? 10_000;
  if (await confirm(target, marker, before, confirmMs, pollMs))
    return { delivered: true, confirmed: true };
  // Enter that read as part of a paste leaves the message in the input box:
  // the input box is ours then, so one more Enter sends it.
  const screen = await target.tmux(["capture-pane", "-p", "-e"]);
  if (
    claudeInputState(screen).state === "draft" &&
    stripEscapes(screen).includes(marker.slice(0, 40))
  ) {
    await target.tmux(["send-keys", "Enter"]);
    return { delivered: true, confirmed: await confirm(target, marker, before, confirmMs, pollMs) };
  }
  return { delivered: true, confirmed: false };
}
