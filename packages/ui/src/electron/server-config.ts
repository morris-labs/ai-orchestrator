// Where an Electron main process finds the server: its data directory, and
// the origin from the environment or from the port in `config.json`.
// Node.js only, like the rest of `@agentbox/ui/electron-main`.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { DEFAULT_SERVER_PORT, HOME_PATHS } from "@agentbox/contracts";

type Env = Record<string, string | undefined>;

/**
 * The path of a file in the server's data directory: `AGENTBOX_DATA_DIR`,
 * else `~/.claude-box`. `homeRelative` is one of the `HOME_PATHS` entries.
 */
export function dataFile(homeRelative: string, env: Env = process.env, home = homedir()): string {
  const dataDir = env.AGENTBOX_DATA_DIR
    ? resolve(env.AGENTBOX_DATA_DIR)
    : join(home, HOME_PATHS.dataDir);
  return join(dataDir, posix.relative(HOME_PATHS.dataDir, homeRelative));
}

/**
 * The server origin, without a trailing slash: `AGENTBOX_SERVER_URL`, else
 * `https://127.0.0.1:PORT`, where `PORT` is `serverPort` in the data
 * directory's `config.json`, or the default port when the file or the key
 * is missing.
 */
export function serverUrl(env: Env = process.env, home = homedir()): string {
  if (env.AGENTBOX_SERVER_URL) return env.AGENTBOX_SERVER_URL.replace(/\/$/, "");
  let port = DEFAULT_SERVER_PORT;
  try {
    const cfg = JSON.parse(readFileSync(dataFile(HOME_PATHS.config, env, home), "utf8")) as {
      serverPort?: unknown;
    };
    if (typeof cfg.serverPort === "number") port = cfg.serverPort;
  } catch {
    // No config file, or one that doesn't parse: the default port applies.
  }
  return `https://127.0.0.1:${port}`;
}
