// The host side of a project container's keeper state:
// `~/.claude-box/state/<container>/sessions` (live tmux sessions, rewritten
// every second) and `mounts` (the mounts the container was created with).
import fs from "node:fs";
import path from "node:path";
import { homePaths, type HostEnv } from "../records/env.js";

/** Seconds a sessions file stays trustworthy; an older one means the keeper is gone. */
export const STATE_MAX_AGE_SEC = 6;

export function stateDir(env: HostEnv, container: string): string {
  return path.join(homePaths(env).stateDir, container);
}

export function stateFile(env: HostEnv, container: string): string {
  return path.join(stateDir(env, container), "sessions");
}

export function mountsFile(env: HostEnv, container: string): string {
  return path.join(stateDir(env, container), "mounts");
}

/** The names in a sessions file's content, one per line. */
export function parseSessions(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/**
 * The live sessions of a container according to its state file, or `[]`
 * when the file is missing or older than `STATE_MAX_AGE_SEC`.
 */
export function liveSessions(env: HostEnv, container: string): string[] {
  const file = stateFile(env, container);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  if ((env.now().getTime() - stat.mtimeMs) / 1000 > STATE_MAX_AGE_SEC) return [];
  try {
    return parseSessions(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

/** Live sessions of every container with a state directory. */
export function allLiveSessions(env: HostEnv): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(homePaths(env).stateDir);
  } catch {
    return [];
  }
  return names.flatMap((c) => liveSessions(env, c));
}

/**
 * Creates the state directory and removes a sessions file left by an earlier
 * container of the same name, so it cannot pass for a live one. Returns the
 * bind `HOST:/run/claude-box`.
 */
export function prepareStateDir(env: HostEnv, container: string, mountPoint: string): string {
  const dir = stateDir(env, container);
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(stateFile(env, container), { force: true });
  return `${dir}:${mountPoint}`;
}

/** Records the mounts a container was created with, one `HOST:CONTAINER` per line. */
export function writeMountsFile(env: HostEnv, container: string, mounts: readonly string[]): void {
  fs.mkdirSync(stateDir(env, container), { recursive: true });
  fs.writeFileSync(mountsFile(env, container), mounts.map((m) => `${m}\n`).join(""));
}

/** The recorded mounts, or `null` when the container predates the file. */
export function readMountsFile(env: HostEnv, container: string): string[] | null {
  try {
    return parseSessions(fs.readFileSync(mountsFile(env, container), "utf8"));
  } catch {
    return null;
  }
}
