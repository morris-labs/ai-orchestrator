// Typing a message into a box's interactive session without answering a
// dialog. The facts behind each step are in
// `docs/build-pipeline/vendor-cli-facts.md`:
//
// - A line typed while Claude Code shows a dialog is dropped, and the Enter
//   after it answers the dialog, even approving a tool call. So for a Claude
//   Code session, the server reads the screen first and types only when the
//   input box shows and is empty.
// - Text and Enter in one fast `send-keys` call can read as a paste, which
//   turns Enter into a line break. So Enter goes in its own call after a
//   pause.
// - Claude Code records each message it takes in the session's transcript,
//   including one that queues behind a busy turn. So the server confirms a
//   delivery there, and a message whose marker the transcript holds is
//   never typed twice.
import type { Platform } from "@aio/contracts";
import { claudeInputState } from "./session-input.js";

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
   * A string that appears in the message and nowhere else, such as an inbox
   * item's marker. Default: the text. A transcript that holds it already
   * means the message arrived, so it isn't typed again.
   */
  marker?: string;
  /** Refuses a session that doesn't run Claude Code, whose screen the server can't read. */
  claudeOnly?: boolean;
}

export type DeliveryResult =
  /**
   * The message was typed. `confirmed` is true when the transcript shows it,
   * false when it didn't in time, and `null` when the server has no
   * transcript to read.
   */
  | { delivered: true; confirmed: boolean | null }
  /** Nothing was typed: the session can't take a message now. `stopped` marks a box that isn't running. */
  | { delivered: false; reason: string; stopped?: true };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The form a string takes inside a JSON string, as transcript lines hold it. */
function inJson(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

async function holds(target: DeliveryTarget, marker: string): Promise<boolean> {
  const transcript = await target.transcript();
  return transcript !== null && transcript.includes(inJson(marker));
}

/** Waits up to `ms` for the transcript to hold `marker`. */
async function confirm(
  target: DeliveryTarget,
  marker: string,
  ms: number,
  pollMs: number,
): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await holds(target, marker)) return true;
    if (Date.now() >= end) return false;
    await sleep(pollMs);
  }
}

/**
 * Types `request.text` into the session and presses Enter. For a Claude Code
 * session, types only when the input box shows and is empty, and confirms
 * the message from the transcript.
 */
export async function deliverToSession(
  target: DeliveryTarget,
  request: DeliveryRequest,
  timing: DeliveryTiming = {},
): Promise<DeliveryResult> {
  const marker = request.marker ?? request.text;
  const claude = target.platform === "claude";
  if (!claude && request.claudeOnly) {
    return {
      delivered: false,
      reason: `The session runs ${target.platform}, and only a Claude Code session takes these messages.`,
    };
  }
  if (claude) {
    if (await holds(target, marker)) return { delivered: true, confirmed: true };
    const input = claudeInputState(await target.tmux(["capture-pane", "-p"]));
    if (input.state !== "ready") return { delivered: false, reason: input.reason };
  }
  // `--` keeps a message that starts with `-` from being read as flags.
  await target.tmux(["send-keys", "-l", "--", request.text]);
  await sleep(timing.pauseMs ?? 500);
  await target.tmux(["send-keys", "Enter"]);
  if (!claude || (await target.transcript()) === null) return { delivered: true, confirmed: null };
  const pollMs = timing.pollMs ?? 250;
  const confirmMs = timing.confirmMs ?? 10_000;
  if (await confirm(target, marker, confirmMs, pollMs)) return { delivered: true, confirmed: true };
  // Enter that read as part of a paste leaves the message in the input box:
  // the input box is ours then, so one more Enter sends it.
  const screen = await target.tmux(["capture-pane", "-p"]);
  if (claudeInputState(screen).state === "draft" && screen.includes(marker.slice(0, 40))) {
    await target.tmux(["send-keys", "Enter"]);
    return { delivered: true, confirmed: await confirm(target, marker, confirmMs, pollMs) };
  }
  return { delivered: true, confirmed: false };
}
