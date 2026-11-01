// The commands that attach to a box's tmux session, a side session, or a
// shell (inventory section 5).
import type { Platform } from "@aio/contracts";

/**
 * Waits up to 30 seconds for the session, then attaches. `-d` detaches any
 * other client so the embedded terminal's size wins, as in 3.3.5.
 */
export const EMBEDDED_ATTACH_SCRIPT =
  'for i in $(seq 1 300); do tmux has-session -t "=$1" 2>/dev/null && break; sleep 0.1; done; exec tmux attach -d -t "=$1"';

/** The external-terminal variant: no `-d`, so the embedded terminal stays attached. */
export const EXTERNAL_ATTACH_SCRIPT =
  'for i in $(seq 1 300); do tmux has-session -t "=$1" 2>/dev/null && break; sleep 0.1; done; exec tmux attach -t "=$1"';

/** The tmux session of a side session for `platform`. */
export function sideSessionName(session: string, platform: Platform): string {
  return `${session}-${platform}`;
}

/** The in-container command for an embedded terminal on a tmux session. */
export function attachCmd(session: string): string[] {
  return ["bash", "-c", EMBEDDED_ATTACH_SCRIPT, "_", session];
}

/** The in-container command for an embedded shell. */
export function shellCmd(): string[] {
  return ["bash", "-l"];
}

export interface ExternalAttachInput {
  container: string;
  kind: "session" | "side" | "shell";
  session: string;
  platform?: Platform;
  workDir: string;
}

/** The host argv that attaches an external terminal (`boxes.attachCommand`). */
export function externalAttachArgv(input: ExternalAttachInput): string[] {
  if (input.kind === "shell") {
    return ["docker", "exec", "-it", "-w", input.workDir, input.container, "bash", "-l"];
  }
  const session =
    input.kind === "side" && input.platform
      ? sideSessionName(input.session, input.platform)
      : input.session;
  return [
    "docker",
    "exec",
    "-it",
    "--detach-keys=ctrl-],ctrl-]",
    input.container,
    "bash",
    "-c",
    EXTERNAL_ATTACH_SCRIPT,
    "_",
    session,
  ];
}
