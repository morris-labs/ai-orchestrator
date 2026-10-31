// Where the server is, which token to send, and which certificate to trust.
import { readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_SERVER_PORT, HOME_PATHS, parseConfig } from "@agentbox/contracts";
import {
  pinnedFetch,
  pinnedTlsOptions,
  readServerPin,
  type ServerPin,
} from "@agentbox/contracts/tls";

export interface CliSettings {
  baseUrl: string;
  token: string | null;
  /** Where the token came from, for `doctor`. */
  tokenSource: "AGENTBOX_TOKEN" | "file" | "none";
  tokenFile: string;
  /** The server's certificate, which the CLI pins for a server on this machine. */
  certFile: string;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Returns the server's data directory: `AGENTBOX_DATA_DIR` when set, the same
 * variable `agentbox-server` reads, else `~/.claude-box`.
 */
export function dataDirFor(env: Record<string, string | undefined>, home: string): string {
  const override = env.AGENTBOX_DATA_DIR;
  return override ? path.resolve(override) : path.join(home, HOME_PATHS.dataDir);
}

/** A `HOME_PATHS` entry under `~/.claude-box`, resolved against the data directory. */
function inDataDir(dataDir: string, homeRelative: string): string {
  return path.join(dataDir, path.posix.relative(HOME_PATHS.dataDir, homeRelative));
}

/**
 * Resolves the server URL and token. The data directory is
 * `AGENTBOX_DATA_DIR`, else `~/.claude-box`.
 *
 * - URL: `--server`, then `AGENTBOX_SERVER`, then `https://127.0.0.1:<serverPort>`
 *   with the port from `config.json` in the data directory (21400 by default).
 * - Token: `AGENTBOX_TOKEN`, then `server.token` in the data directory.
 * - Certificate: `server.crt` in the data directory.
 */
export function resolveSettings(options: {
  env: Record<string, string | undefined>;
  home: string;
  server?: string;
}): CliSettings {
  const { env, home } = options;
  const dataDir = dataDirFor(env, home);
  let port = DEFAULT_SERVER_PORT;
  const configText = readText(inDataDir(dataDir, HOME_PATHS.config));
  if (configText !== null) {
    try {
      port = parseConfig(JSON.parse(configText)).serverPort;
    } catch {
      // A broken config file leaves the default port; the server reports the problem.
    }
  }
  const baseUrl = options.server ?? env.AGENTBOX_SERVER ?? `https://127.0.0.1:${port}`;
  const tokenFile = inDataDir(dataDir, HOME_PATHS.serverToken);
  const certFile = inDataDir(dataDir, HOME_PATHS.serverCert);
  const files = { tokenFile, certFile };
  const fromEnv = env.AGENTBOX_TOKEN?.trim();
  if (fromEnv) return { baseUrl, token: fromEnv, tokenSource: "AGENTBOX_TOKEN", ...files };
  const fromFile = readText(tokenFile)?.trim();
  if (fromFile) return { baseUrl, token: fromFile, tokenSource: "file", ...files };
  return { baseUrl, token: null, tokenSource: "none", ...files };
}

/**
 * True when the CLI pins the server's certificate for `baseUrl`: an `https`
 * server on this machine must be this machine's Agent Box server. For a
 * server elsewhere, the system's trusted authorities apply.
 */
export function pinsServer(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  return url.protocol === "https:" && isLoopbackHost(url.hostname);
}

/** Reads the certificate in `certFile`. Throws when the server has never created it. */
export function serverPin(settings: Pick<CliSettings, "certFile">): ServerPin {
  const pin = readServerPin(settings.certFile);
  if (!pin) {
    throw new Error(
      `No server certificate at ${settings.certFile}. The server creates it on its first start.`,
    );
  }
  return pin;
}

/**
 * The `fetch` for the server: one that pins `certFile`, read again for
 * every request, when `pinsServer()` says so, else the global one.
 */
export function serverFetch(settings: Pick<CliSettings, "baseUrl" | "certFile">): typeof fetch {
  return pinsServer(settings.baseUrl)
    ? pinnedFetch(() => serverPin(settings))
    : (...args) => globalThis.fetch(...args);
}

/** The TLS options for a WebSocket to the server; see `serverFetch()`. */
export function serverTls(
  settings: Pick<CliSettings, "baseUrl" | "certFile">,
): ReturnType<typeof pinnedTlsOptions> | Record<string, never> {
  return pinsServer(settings.baseUrl) ? pinnedTlsOptions(serverPin(settings)) : {};
}

/**
 * True when `host` is this machine: `localhost`, 127.0.0.0/8, `::1`, or
 * 127.0.0.0/8 mapped into IPv6. A trailing dot, as in `localhost.`, names
 * the same host. `URL` writes a mapped address such as `::ffff:127.0.0.1`
 * in hex, as `::ffff:7f00:1`, so both forms count.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(h) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(h) ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(h)
  );
}

/**
 * Checks that the server URL is safe to send the token to: `https`, or
 * plain `http` only when `insecure` allows it. On this machine, plain HTTP
 * would reach whatever program listens on the server port while the server
 * is down. Returns an error message, or `null` when the URL is fine.
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
  if (insecure) return null;
  if (isLoopbackHost(url.hostname)) {
    return `The CLI won't send its token over plain HTTP to ${url.host}. The server serves HTTPS: use https://${url.host}.`;
  }
  return `The CLI won't send its token over plain HTTP to ${url.host}. Use https, or pass --insecure if you trust the network.`;
}

/**
 * The script the server's session and side-session attach commands run in
 * the container. It is a copy of `EXTERNAL_ATTACH_SCRIPT` in
 * `packages/server/src/terminals/attach.ts`; a test checks the two match.
 */
export const ATTACH_SCRIPT =
  'for i in $(seq 1 300); do tmux has-session -t "=$1" 2>/dev/null && break; sleep 0.1; done; exec tmux attach -t "=$1"';

/** A box container name: docker's name rules, under the `claude-agent-` prefix. */
const CONTAINER_NAME = /^claude-agent-[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
/** A tmux session name the attach script receives as `$1`. */
const SESSION_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;

/** True for an absolute POSIX path with no control characters. */
function isWorkDir(path: string): boolean {
  // eslint-disable-next-line no-control-regex
  return path.startsWith("/") && !/[\x00-\x1f\x7f]/.test(path);
}

/** Matches `argv` against `shape`, where a function checks a variable argument. */
function matchesShape(
  argv: readonly string[],
  shape: readonly (string | ((arg: string) => boolean))[],
): boolean {
  return (
    argv.length === shape.length &&
    shape.every((part, i) => {
      const arg = argv[i]!;
      return typeof part === "string" ? arg === part : part(arg);
    })
  );
}

const isContainer = (arg: string) => CONTAINER_NAME.test(arg);
const isSession = (arg: string) => SESSION_NAME.test(arg);

/**
 * The argv shapes `boxes.attachCommand` returns: `docker exec` into a box
 * container with a shell, or with the fixed script that attaches to a tmux
 * session. Nothing else, so a hostile server can't add flags such as
 * `--privileged`, `-v`, or `--mount`, or run `docker run`.
 */
const ATTACH_SHAPES: readonly (readonly (string | ((arg: string) => boolean))[])[] = [
  ["docker", "exec", "-it", "-w", isWorkDir, isContainer, "bash", "-l"],
  [
    "docker",
    "exec",
    "-it",
    "--detach-keys=ctrl-],ctrl-]",
    isContainer,
    "bash",
    "-c",
    ATTACH_SCRIPT,
    "_",
    isSession,
  ],
];

/**
 * Checks an argv the server returned for `box attach` and `box open`. The
 * argv must have one of the exact shapes the server builds, which run
 * `docker exec` into a box container, with `docker` found on `PATH` rather
 * than a path the server picked. Returns an error message, or `null`.
 */
export function checkAttachArgv(argv: readonly string[]): string | null {
  if (argv.length === 0) return "The server returned an empty attach command.";
  if (argv[0] !== "docker") {
    return `The server asked to run ${JSON.stringify(argv[0])}; the CLI runs only docker exec to attach.`;
  }
  if (!ATTACH_SHAPES.some((shape) => matchesShape(argv, shape))) {
    return `The server's attach command isn't one the CLI runs: ${JSON.stringify(argv.join(" ").slice(0, 200))}. The CLI runs only docker exec into a box container.`;
  }
  return null;
}
