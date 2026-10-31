// The command lines a box's sessions run (inventory section 4.3), kept in one
// place so creating and reopening a box can't drift apart.
import type { Box, Platform, Project } from "@agentbox/contracts";
import { hostToContainer, promptPath, type HostEnv } from "../records/env.js";
import { normalizeRoot } from "../projects/ids.js";
import { infraFile, worktreeNotesDir } from "../worktrees/worktrees.js";

/**
 * The `claude` flags shared by creating and reopening a box: remote control
 * (named after the conversation), auto permission mode, the bypass option,
 * the model and effort, and `--add-dir` for the project root when a worktree
 * box's repository is a subdirectory of it.
 */
export function baseClaudeArgs(box: Box, project: Pick<Project, "root" | "primaryRepo">): string[] {
  // `--flag=value` keeps a name that starts with "-" a value: claude reads
  // `--remote-control -x` as the flag with no name, followed by `-x`.
  const args = [
    box.conversationName === "" ? "--remote-control" : `--remote-control=${box.conversationName}`,
  ];
  args.push("--permission-mode", "auto");
  if (box.skipPermissions) args.push("--allow-dangerously-skip-permissions");
  if (box.model) args.push("--model", box.model);
  if (box.effort) args.push("--effort", box.effort);
  if (box.worktree && project.primaryRepo && normalizeRoot(project.primaryRepo) !== project.root) {
    args.push("--add-dir", hostToContainer(box.targetDir));
  }
  return args;
}

/**
 * Arguments for a CLI other than claude, or claude's own base arguments.
 * `resume` picks up the CLI's latest session in the working directory, since
 * neither Codex nor Copilot keeps a session id the server records.
 */
export function platformArgs(
  box: Box,
  project: Pick<Project, "root" | "primaryRepo">,
  program: Platform,
  resume: boolean,
  prompt: string,
): string[] {
  const args: string[] = [];
  if (program === "codex") {
    if (resume) args.push("resume", "--last");
    if (box.skipPermissions) args.push("--dangerously-bypass-approvals-and-sandbox");
    // After `--`, a prompt that starts with `-` or names a subcommand is still the prompt.
    if (!resume && prompt !== "") args.push("--", prompt);
    return args;
  }
  if (program === "copilot") {
    args.push("--remote");
    if (resume) args.push("--continue");
    if (box.skipPermissions) args.push("--allow-all-tools");
    if (!resume && prompt !== "") args.push("-i", prompt);
    return args;
  }
  return baseClaudeArgs(box, project);
}

/**
 * A side session's arguments: `codex remote-control --no-daemon`, else the
 * platform's own. A bare `codex remote-control` manages a background daemon;
 * `--no-daemon` keeps it in the foreground, so the tmux session lives as long
 * as remote control does.
 */
export function sideSessionArgs(
  box: Box,
  project: Pick<Project, "root" | "primaryRepo">,
  program: Platform,
): string[] {
  return program === "codex"
    ? ["remote-control", "--no-daemon"]
    : platformArgs(box, project, program, false, "");
}

/** The first message of a resumed session after Convert to Worktree (inventory section 4.5). */
export function movedMessage(env: HostEnv, box: Box): string {
  const worktree = box.worktree as string;
  const movedFrom = box.movedFrom as string;
  return (
    `This conversation was moved into a git worktree. Your working directory is now ${promptPath(env, worktree)} ` +
    `(branch ${box.branch ?? ""}). The folder you used before, ${promptPath(env, movedFrom)}, was renamed to ` +
    `${promptPath(env, `${movedFrom}.pre-worktree`)} and must not be used ` +
    `any more. Your PLAN.md and STATUS.md are now in ${promptPath(env, worktreeNotesDir(worktree))}, and the shared INFRA.md is ` +
    `${promptPath(env, infraFile(box.targetDir))}. ` +
    "Read them there, keep updating them there, and use these paths in place of any earlier " +
    "ones from this conversation. Reply with one line to confirm, then carry on."
  );
}

/** `--name=<name>`, in the one form that keeps a leading "-" part of the name. */
export function nameArg(name: string): string {
  return `--name=${name}`;
}
