// Where the engine finds its bearer token. The server writes it to a 0600
// file in the keeper's state directory before the container starts and names
// that file in `AIO_ENGINE_TOKEN_FILE`, so the token is never part of
// the container's environment, which every `docker exec` (and so every tmux
// session and agent CLI) inherits.
import { readFileSync } from "node:fs";
import { ENGINE_ENV, type EngineEnv } from "@aio/contracts";

export type TokenLoad = { ok: true; token: string } | { ok: false; problem: string };

/**
 * Returns the bearer token from a validated environment: the content of
 * `AIO_ENGINE_TOKEN_FILE` when it is set, else `AIO_ENGINE_TOKEN`.
 * The problem names the file, never its content.
 */
export function loadEngineToken(
  env: EngineEnv,
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): TokenLoad {
  const file = env[ENGINE_ENV.tokenFile];
  if (file === undefined) {
    const token = env[ENGINE_ENV.token];
    return token === undefined
      ? { ok: false, problem: `Neither ${ENGINE_ENV.tokenFile} nor ${ENGINE_ENV.token} is set.` }
      : { ok: true, token };
  }
  let token: string;
  try {
    token = read(file).trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "an error";
    return { ok: false, problem: `The engine token file ${file} can't be read (${code}).` };
  }
  if (token === "") return { ok: false, problem: `The engine token file ${file} is empty.` };
  if (token.length < 16) {
    return { ok: false, problem: `The engine token in ${file} must be at least 16 characters.` };
  }
  return { ok: true, token };
}
