// A client of the secrets broker: the Unix socket the server mounts into
// each project container, or under Docker Desktop, a TCP listener on the
// host that checks a bearer token (see `docs/secrets.md`). The engine uses
// it to get the credentials it hands vendor CLIs and `git`, and the
// `aio-secret` command wraps it for everything else in the container.
//
// This module imports only Node built-ins and the contracts, so the
// `aio-secret` command starts fast.
import { readFileSync } from "node:fs";
import http from "node:http";
import {
  BROKER_ENV,
  BROKER_ROUTES,
  BROKER_SOCKET_PATH,
  BROKER_TOKEN_PATH,
  BROKER_URL_PATH,
  BrokerNamesResponseSchema,
  BrokerReadResponseSchema,
} from "@aio/contracts";

/**
 * Why a broker call failed:
 *
 * - `unreachable`: no broker answers at the socket or URL, or the TCP
 *   broker refused the token (`unauthorized`), as after the container was
 *   created again.
 * - `unsupported`: the environment names a broker URL this client can't use.
 * - `not_found`: the project doesn't list a requested name.
 * - `secrets_locked`, `secrets_unavailable`: 1Password is locked, or a
 *   reference doesn't resolve.
 * - `protocol`: the broker answered with something this client can't read.
 * - `validation`, `internal`: the broker refused the request or failed.
 */
export type BrokerClientErrorCode =
  | "unreachable"
  | "unsupported"
  | "not_found"
  | "secrets_locked"
  | "secrets_unavailable"
  | "protocol"
  | "validation"
  | "internal";

export class BrokerError extends Error {
  constructor(
    readonly code: BrokerClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

const BROKER_CODES = new Set<BrokerClientErrorCode>([
  "not_found",
  "secrets_locked",
  "secrets_unavailable",
  "validation",
  "internal",
]);

/** Where the broker is: a Unix socket, or a TCP URL with a token file. */
export type BrokerEndpoint =
  | { transport: "unix"; socketPath: string }
  | { transport: "tcp"; host: string; port: number; url: string; tokenFile: string };

/** Where a client finds the broker. */
export interface BrokerClientOptions {
  /** The socket path. Default: from `brokerEndpoint()`. */
  socketPath?: string;
  /** The broker, in place of `socketPath`. Default: from `brokerEndpoint()`. */
  endpoint?: BrokerEndpoint;
  /** The environment to read the transport from. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Gives up on a call after this many milliseconds. Default: 60 seconds, for a 1Password unlock. */
  timeoutMs?: number;
}

/** Reads a file's text, or `null` when it can't be read; tests replace it. */
export type ReadText = (file: string) => string | null;

const readText: ReadText = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * Parses a TCP broker URL: `http://HOST:PORT` with nothing after the port
 * but an optional `/`. Throws `unsupported` for anything else, such as
 * `https`, which the broker doesn't serve, or a path, which it would ignore.
 */
export function parseBrokerUrl(
  url: string,
  tokenFile: string = BROKER_TOKEN_PATH,
): BrokerEndpoint & { transport: "tcp" } {
  let parsed: URL | null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  const port = Number(parsed?.port);
  if (
    !parsed ||
    parsed.protocol !== "http:" ||
    parsed.hostname === "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new BrokerError(
      "unsupported",
      `${BROKER_ENV.url} must be http://HOST:PORT, such as http://host.docker.internal:41000.`,
    );
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  return { transport: "tcp", host, port, url: `http://${parsed.host}`, tokenFile };
}

/**
 * The broker a client in this environment uses, first match wins:
 *
 * 1. `AIO_BROKER_URL`: TCP, with the token in `BROKER_TOKEN_PATH`.
 * 1. `AIO_BROKER_SOCKET`: that Unix socket.
 * 1. The URL in `BROKER_URL_PATH`, which the server writes for a TCP
 *    container: the engine withholds every `AIO_` variable from the
 *    processes it starts, so they find the broker through this file.
 * 1. The Unix socket at `BROKER_SOCKET_PATH`.
 */
export function brokerEndpoint(
  env: Record<string, string | undefined> = process.env,
  read: ReadText = readText,
): BrokerEndpoint {
  const url = env[BROKER_ENV.url];
  if (url) return parseBrokerUrl(url);
  const socket = env[BROKER_ENV.socket];
  if (socket) return { transport: "unix", socketPath: socket };
  const fromFile = read(BROKER_URL_PATH)?.trim();
  if (fromFile) return parseBrokerUrl(fromFile);
  return { transport: "unix", socketPath: BROKER_SOCKET_PATH };
}

/**
 * The socket path a client in this environment uses. Throws `unsupported`
 * when the environment names a TCP broker; use `brokerEndpoint()` for both.
 */
export function brokerSocketPath(env: Record<string, string | undefined> = process.env): string {
  const endpoint = brokerEndpoint(env, () => null);
  if (endpoint.transport !== "unix") {
    throw new BrokerError(
      "unsupported",
      `${BROKER_ENV.url} names a TCP secrets broker, which has no socket path.`,
    );
  }
  return endpoint.socketPath;
}

export class BrokerClient {
  readonly endpoint: BrokerEndpoint;
  private readonly timeoutMs: number;
  private readonly readFile: ReadText;

  constructor(options: BrokerClientOptions & { readText?: ReadText } = {}) {
    this.readFile = options.readText ?? readText;
    this.endpoint =
      options.endpoint ??
      (options.socketPath !== undefined
        ? { transport: "unix", socketPath: options.socketPath }
        : brokerEndpoint(options.env ?? process.env, this.readFile));
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** The socket path, or the URL of a TCP broker: where error messages say the broker is. */
  get socketPath(): string {
    return this.endpoint.transport === "unix" ? this.endpoint.socketPath : this.endpoint.url;
  }

  /**
   * The bearer token, read again for every call: the server writes a new
   * one each time it creates the container.
   */
  private token(endpoint: BrokerEndpoint & { transport: "tcp" }): string {
    const token = this.readFile(endpoint.tokenFile)?.trim() ?? "";
    if (token === "") {
      throw new BrokerError(
        "unreachable",
        `Can't read the secrets broker token at ${endpoint.tokenFile}. The AI Orchestrator server might be stopped.`,
      );
    }
    return token;
  }

  /** The names the container may request. */
  async names(): Promise<string[]> {
    const body = await this.call("GET", BROKER_ROUTES.names);
    const parsed = BrokerNamesResponseSchema.safeParse(body);
    if (!parsed.success) throw this.protocolError();
    return parsed.data.names;
  }

  /**
   * The values of `names`, all or nothing. `caller` describes the asking
   * program for the broker's log; it never affects the answer.
   */
  async read(names: readonly string[], caller?: string): Promise<Record<string, string>> {
    const unique = [...new Set(names)];
    if (unique.length === 0) return {};
    const body = await this.call("POST", BROKER_ROUTES.read, {
      names: unique,
      ...(caller ? { caller: caller.slice(0, 500) } : {}),
    });
    const parsed = BrokerReadResponseSchema.safeParse(body);
    if (!parsed.success) throw this.protocolError();
    for (const name of unique) {
      if (parsed.data.values[name] === undefined) throw this.protocolError();
    }
    return Object.fromEntries(unique.map((n) => [n, parsed.data.values[n]!]));
  }

  private protocolError(): BrokerError {
    return new BrokerError(
      "protocol",
      `The secrets broker at ${this.socketPath} sent an answer this client can't read.`,
    );
  }

  private call(method: string, route: string, payload?: unknown): Promise<unknown> {
    const data = payload === undefined ? undefined : JSON.stringify(payload);
    const endpoint = this.endpoint;
    const headers: Record<string, string | number> = data
      ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
      : {};
    let target: http.RequestOptions;
    if (endpoint.transport === "tcp") {
      let token: string;
      try {
        token = this.token(endpoint);
      } catch (err) {
        return Promise.reject(err);
      }
      headers.authorization = `Bearer ${token}`;
      target = { host: endpoint.host, port: endpoint.port };
    } else {
      target = { socketPath: endpoint.socketPath };
    }
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          ...target,
          method,
          path: route,
          headers,
          // No keep-alive pool: one request per connection, as on the socket.
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", (err) => reject(this.unreachable(err)));
          res.on("end", () => {
            let body: unknown;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              reject(this.protocolError());
              return;
            }
            if (res.statusCode === 200) {
              resolve(body);
              return;
            }
            if (res.statusCode === 401) {
              reject(
                new BrokerError(
                  "unreachable",
                  `The secrets broker at ${this.socketPath} refused this container's token. Restart the box's project container if it persists.`,
                ),
              );
              return;
            }
            const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
            const code = BROKER_CODES.has(error?.code as BrokerClientErrorCode)
              ? (error!.code as BrokerClientErrorCode)
              : "internal";
            const message =
              typeof error?.message === "string"
                ? error.message
                : `The secrets broker failed with status ${res.statusCode ?? "unknown"}.`;
            reject(new BrokerError(code, message));
          });
        },
      );
      // A deadline for the whole call: `req.setTimeout` only starts once the
      // socket connects, so it misses a TCP name lookup or connect that hangs.
      const deadline = setTimeout(() => {
        req.destroy(new Error(`no answer within ${Math.round(this.timeoutMs / 1000)} seconds`));
      }, this.timeoutMs);
      req.on("close", () => clearTimeout(deadline));
      req.on("error", (err) => reject(this.unreachable(err)));
      req.end(data);
    });
  }

  private unreachable(err: Error): BrokerError {
    return new BrokerError(
      "unreachable",
      `Can't reach the secrets broker at ${this.socketPath}: ${err.message}. The AI Orchestrator server might be stopped.`,
    );
  }
}
