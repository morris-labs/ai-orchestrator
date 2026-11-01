// Keeps credentials out of the engine's own `/proc/PID/environ`. That file
// shows the environment a process was started with, and deleting a variable
// from `process.env` doesn't change it, so any process of the same user can
// read the engine's bearer token and the vendor and GitHub tokens there.
//
// At startup the engine moves those variables into a 0600 file in a new
// 0700 directory and executes itself again without them. The new process
// reads the file, deletes it, and puts the values back into `process.env`,
// which lives on the heap: children still get them through `childEnv()`,
// but `/proc/PID/environ` no longer holds them.
//
// This module imports only Node built-ins, so a test can run it directly.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Names the file that holds the moved variables, for the re-executed engine. */
export const MOVED_ENV_FILE = "AIO_ENGINE_MOVED_ENV_FILE";

const DIR_PREFIX = "aio-engine-env-";

export type EnvironStep =
  /** Nothing to move, or the moved variables are back in `process.env`. */
  | { kind: "ready"; restored: number }
  /** Moving needs `process.execve`, which this Node lacks; the variables stay. */
  | { kind: "unsupported"; names: string[] };

export interface EnvironOptions {
  /** True for a variable that must not stay in the environ, such as a token. */
  isSecret: (name: string) => boolean;
  /** Replaces `process.execve`, for tests. */
  execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => never;
}

/**
 * Moves the secret variables out of this process's environ by executing it
 * again, or, in the re-executed process, puts them back into `process.env`.
 * Returns only when there is nothing more to do; the first step never
 * returns, since `execve` replaces the process.
 */
export function moveSecretsOutOfEnviron(options: EnvironOptions): EnvironStep {
  const env = process.env;
  const file = env[MOVED_ENV_FILE];
  if (file !== undefined) {
    delete env[MOVED_ENV_FILE];
    let moved: Record<string, string>;
    try {
      moved = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    } finally {
      // Only a directory this module made: the name comes from the environment.
      if (basename(dirname(file)).startsWith(DIR_PREFIX)) {
        rmSync(dirname(file), { recursive: true, force: true });
      }
    }
    for (const [name, value] of Object.entries(moved)) {
      if (typeof value === "string") env[name] = value;
    }
    return { kind: "ready", restored: Object.keys(moved).length };
  }
  const names = Object.keys(env).filter((n) => env[n] !== undefined && options.isSecret(n));
  if (names.length === 0) return { kind: "ready", restored: 0 };
  const execve =
    options.execve ??
    (typeof process.execve === "function" ? process.execve.bind(process) : undefined);
  if (!execve) return { kind: "unsupported", names };

  const dir = mkdtempSync(join(tmpdir(), DIR_PREFIX));
  const target = join(dir, "env.json");
  const moved: Record<string, string> = {};
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (names.includes(name)) moved[name] = value;
    else next[name] = value;
  }
  try {
    writeFileSync(target, JSON.stringify(moved), { mode: 0o600 });
    next[MOVED_ENV_FILE] = target;
    const args = [process.execPath, ...process.execArgv, ...process.argv.slice(1)];
    return execve(process.execPath, args, next);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
