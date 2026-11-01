// Where an Electron main process finds the server: its data directory, and
// the origin from the environment or from the port the server wrote.
// Node.js only, like the rest of `@aio/ui/electron-main`.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, resolve } from "node:path";
import { DEFAULT_SERVER_PORT, HOME_PATHS } from "@aio/contracts";

type Env = Record<string, string | undefined>;

/**
 * The path of a file in the server's data directory: `AIO_DATA_DIR`,
 * else `~/.ai-orchestrator`. `homeRelative` is one of the `HOME_PATHS` entries.
 */
export function dataFile(homeRelative: string, env: Env = process.env, home = homedir()): string {
  const dataDir = env.AIO_DATA_DIR ? resolve(env.AIO_DATA_DIR) : join(home, HOME_PATHS.dataDir);
  return join(dataDir, posix.relative(HOME_PATHS.dataDir, homeRelative));
}

/** `value` as a TCP port, or `null` when it isn't one. */
function asPort(value: unknown): number | null {
  const n = typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * The server origin, without a trailing slash: `AIO_SERVER_URL`, else
 * `https://127.0.0.1:PORT`. `PORT` is the one the running server wrote to
 * `server.port` in the data directory, else `serverPort` in its
 * `config.json`, else the default port. The server takes its port from its
 * database after the first start, so `server.port` wins.
 */
export function serverUrl(env: Env = process.env, home = homedir()): string {
  if (env.AIO_SERVER_URL) return env.AIO_SERVER_URL.replace(/\/$/, "");
  let port: number | null = null;
  try {
    port = asPort(readFileSync(dataFile(HOME_PATHS.serverPort, env, home), "utf8"));
  } catch {
    // No port file: the server hasn't started with this data directory.
  }
  if (port === null) {
    try {
      const cfg = JSON.parse(readFileSync(dataFile(HOME_PATHS.config, env, home), "utf8")) as {
        serverPort?: unknown;
      };
      port = asPort(cfg.serverPort);
    } catch {
      // No config file, or one that doesn't parse: the default port applies.
    }
  }
  return `https://127.0.0.1:${port ?? DEFAULT_SERVER_PORT}`;
}
