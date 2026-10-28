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
 *   with the port from `~/.claude-box/config.json` (21400 by default).
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

/** True when `host` is this machine: `localhost`, 127.0.0.0/8, or `::1`. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * Checks that the server URL is safe to send the token to: `https`, or
 * plain `http` only to this machine unless `insecure` allows it. Returns an
 * error message, or `null` when the URL is fine.
 */
export function checkServerUrl(baseUrl: string, insecure: boolean): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return `The server URL ${baseUrl} isn't a valid URL.`;
  }
  if (url.protocol === "https:") return null;
  if (url.protocol !== "http:") {
    return `The server URL must use http or https, not ${url.protocol.replace(/:$/, "")}.`;
  }
  if (isLoopbackHost(url.hostname) || insecure) return null;
  return `The CLI won't send its token over plain HTTP to ${url.host}. Use https, or pass --insecure if you trust the network.`;
}

/** Programs a server-provided attach command may run, by bare name. */
export const ATTACH_PROGRAMS: readonly string[] = ["docker", "agentbox"];

/**
 * Checks an argv the server returned for `box attach` and `box open`: the
 * program must be `docker` or `agentbox`, found on `PATH`, not a path the
 * server picked. Returns an error message, or `null`.
 */
export function checkAttachArgv(argv: readonly string[]): string | null {
  const program = argv[0];
  if (program === undefined || !ATTACH_PROGRAMS.includes(program)) {
    return `The server asked to run ${JSON.stringify(program ?? "")}; the CLI runs only ${ATTACH_PROGRAMS.join(" or ")} to attach.`;
  }
  return null;
}
