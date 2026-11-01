// The host side of a project container's keeper state:
// `~/.ai-orchestrator/state/<container>/sessions` (live tmux sessions, rewritten
// every second), `mounts` (the mounts the container was created with),
// `engine.token` (the engine's bearer token, mode 0600), and
// `account-dirs.json` (each vendor's default account folder, for the engine).
import fs from "node:fs";
import path from "node:path";
import { ENGINE_ACCOUNT_DIRS_FILE, type EngineAccountDirs } from "@aio/contracts";
import { homePaths, type HostEnv } from "../records/env.js";
import { readRegularFileSync, replaceFileSync } from "../records/regular-file.js";

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

/**
 * The engine token file's name in the state directory. The engine reads it
 * at the path the server passes in `ENGINE_ENV.tokenFile`.
 */
export const ENGINE_TOKEN_FILE_NAME = "engine.token";

export function engineTokenFile(env: HostEnv, container: string): string {
  return path.join(stateDir(env, container), ENGINE_TOKEN_FILE_NAME);
}

/**
 * Writes the engine token for a container about to start, readable by its
 * owner only. The token goes to a file rather than the container's
 * environment because every `docker exec`, and so every tmux session and
 * agent CLI, inherits that environment.
 */
export function writeEngineTokenFile(env: HostEnv, container: string, token: string): void {
  const dir = stateDir(env, container);
  fs.mkdirSync(dir, { recursive: true });
  const file = engineTokenFile(env, container);
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file);
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
 * when the file is missing, older than `STATE_MAX_AGE_SEC`, or not a regular
 * file. The container writes this directory, so a FIFO or a link there is
 * refused rather than read: a FIFO would block the server until a writer
 * appears.
 */
export function liveSessions(env: HostEnv, container: string): string[] {
  const file = stateFile(env, container);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return [];
  }
  if (!stat.isFile()) return [];
  if ((env.now().getTime() - stat.mtimeMs) / 1000 > STATE_MAX_AGE_SEC) return [];
  const content = readRegularFileSync(file);
  return content === null ? [] : parseSessions(content);
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
 * Creates the state directory and removes a sessions file (or a directory at
 * its path) left by an earlier container of the same name, so it cannot pass for a live one. Returns the
 * bind `HOST:/run/aio`.
 */
export function prepareStateDir(env: HostEnv, container: string, mountPoint: string): string {
  const dir = stateDir(env, container);
  fs.mkdirSync(dir, { recursive: true });
  // The container can write this directory and might leave a directory at
  // the file's path; `recursive` removes that too and never follows a link.
  fs.rmSync(stateFile(env, container), { recursive: true, force: true });
  return `${dir}:${mountPoint}`;
}

/**
 * Records the mounts a container was created with, one `HOST:CONTAINER` per
 * line. The container can write the state directory, so the file is
 * replaced rather than written through: a link left at that path is
 * replaced, not followed, and a directory there is removed.
 */
export function writeMountsFile(env: HostEnv, container: string, mounts: readonly string[]): void {
  fs.mkdirSync(stateDir(env, container), { recursive: true });
  replaceFileSync(mountsFile(env, container), mounts.map((m) => `${m}\n`).join(""));
}

/**
 * The recorded mounts, or `null` when the container predates the file or
 * the path holds something other than a regular file.
 */
export function readMountsFile(env: HostEnv, container: string): string[] | null {
  const content = readRegularFileSync(mountsFile(env, container));
  return content === null ? null : parseSessions(content);
}

export function accountDirsFile(env: HostEnv, container: string): string {
  return path.join(stateDir(env, container), ENGINE_ACCOUNT_DIRS_FILE);
}

/**
 * Writes the default account folder of each vendor, as the container sees
 * it, for the engine's vendor calls. An empty object means no folder is
 * known, as in `host` mode. The file is replaced rather than written
 * through, for the same reason as `writeMountsFile()`.
 */
export function writeAccountDirsFile(
  env: HostEnv,
  container: string,
  dirs: EngineAccountDirs,
): void {
  fs.mkdirSync(stateDir(env, container), { recursive: true });
  replaceFileSync(accountDirsFile(env, container), `${JSON.stringify(dirs)}\n`);
}
