// Where the server is and which token to send.
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SERVER_PORT, HOME_PATHS, parseConfig } from "@agentbox/contracts";

export interface CliSettings {
  baseUrl: string;
  token: string | null;
  /** Where the token came from, for `doctor`. */
  tokenSource: "AGENTBOX_TOKEN" | "file" | "none";
  tokenFile: string;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Resolves the server URL and token.
 *
 * - URL: `--server`, then `AGENTBOX_SERVER`, then `http://127.0.0.1:<serverPort>`
 *   with the port from `~/.claude-box/config.json` (20400 by default).
 * - Token: `AGENTBOX_TOKEN`, then `~/.claude-box/server.token`.
 */
export function resolveSettings(options: {
  env: Record<string, string | undefined>;
  home: string;
  server?: string;
}): CliSettings {
  const { env, home } = options;
  let port = DEFAULT_SERVER_PORT;
  const configText = readText(path.join(home, HOME_PATHS.config));
  if (configText !== null) {
    try {
      port = parseConfig(JSON.parse(configText)).serverPort;
    } catch {
      // A broken config file leaves the default port; the server reports the problem.
    }
  }
  const baseUrl = options.server ?? env.AGENTBOX_SERVER ?? `http://127.0.0.1:${port}`;
  const tokenFile = path.join(home, HOME_PATHS.serverToken);
  const fromEnv = env.AGENTBOX_TOKEN?.trim();
  if (fromEnv) return { baseUrl, token: fromEnv, tokenSource: "AGENTBOX_TOKEN", tokenFile };
  const fromFile = readText(tokenFile)?.trim();
  if (fromFile) return { baseUrl, token: fromFile, tokenSource: "file", tokenFile };
  return { baseUrl, token: null, tokenSource: "none", tokenFile };
}
