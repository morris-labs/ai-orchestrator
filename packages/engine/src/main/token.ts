// Where the engine finds its bearer token. The server writes it to a 0600
// file in the keeper's state directory before the container starts, so the
// token is never part of the container's environment, which every
// `docker exec` (and so every tmux session and agent CLI) inherits.
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_ENGINE_STATE_DIR, ENGINE_ENV } from "@agentbox/contracts";

/** The variable that names the token file. */
export const ENGINE_TOKEN_FILE_ENV = "AGENTBOX_ENGINE_TOKEN_FILE";

/** The token file's name inside the state directory. */
export const ENGINE_TOKEN_FILE_NAME = "engine.token";

/** The token file to read: `AGENTBOX_ENGINE_TOKEN_FILE`, or `engine.token` in the state directory. */
export function engineTokenFile(env: Record<string, string | undefined>): string {
  const named = env[ENGINE_TOKEN_FILE_ENV]?.trim();
  if (named) return named;
  const stateDir = env[ENGINE_ENV.stateDir]?.trim() || DEFAULT_ENGINE_STATE_DIR;
  return path.join(stateDir, ENGINE_TOKEN_FILE_NAME);
}

export type TokenLoad =
  | { ok: true; env: Record<string, string | undefined> }
  | { ok: false; problem: string };

/**
 * Returns a copy of `env` with `AGENTBOX_ENGINE_TOKEN` filled from the token
 * file, ready for `checkEnv`. An explicit `AGENTBOX_ENGINE_TOKEN_FILE` always
 * wins. Without one, a token already in the environment stays, for an engine
 * started by hand in development; otherwise the default file is read. The
 * problem names the file, never its content.
 */
export function loadEngineToken(
  env: Record<string, string | undefined>,
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): TokenLoad {
  const explicit = env[ENGINE_TOKEN_FILE_ENV]?.trim();
  if (!explicit && env[ENGINE_ENV.token]) return { ok: true, env: { ...env } };
  const file = engineTokenFile(env);
  let token: string;
  try {
    token = read(file).trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "an error";
    return { ok: false, problem: `The engine token file ${file} can't be read (${code}).` };
  }
  if (token === "") return { ok: false, problem: `The engine token file ${file} is empty.` };
  return { ok: true, env: { ...env, [ENGINE_ENV.token]: token } };
}
