// A client of the secrets broker: the Unix socket the server mounts into
// each project container (docs/v4/design-secrets-broker.md). The engine uses
// it to get the credentials it hands vendor CLIs and `git`, and the
// `agentbox-secret` command wraps it for everything else in the container.
//
// This module imports only Node built-ins and the contracts, so the
// `agentbox-secret` command starts fast.
import http from "node:http";
import {
  BROKER_ENV,
  BROKER_ROUTES,
  BROKER_SOCKET_PATH,
  BrokerNamesResponseSchema,
  BrokerReadResponseSchema,
} from "@agentbox/contracts";

/**
 * Why a broker call failed:
 *
 * - `unreachable`: no broker answers at the socket.
 * - `unsupported`: the environment names a transport this client lacks.
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

/** Where a client finds the broker. */
export interface BrokerClientOptions {
  /** The socket path. Default: `AGENTBOX_BROKER_SOCKET`, else `BROKER_SOCKET_PATH`. */
  socketPath?: string;
  /** The environment to read the transport from. Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Gives up on a call after this many milliseconds. Default: 60 seconds, for a 1Password unlock. */
  timeoutMs?: number;
}

/**
 * The socket path a client in this environment uses. Throws `unsupported`
 * when the environment names a TCP broker: that transport is designed for
 * Docker Desktop but not built.
 */
export function brokerSocketPath(env: Record<string, string | undefined> = process.env): string {
  if (env[BROKER_ENV.url] && !env[BROKER_ENV.socket]) {
    throw new BrokerError(
      "unsupported",
      `${BROKER_ENV.url} names a TCP secrets broker, which this client doesn't support yet. Set ${BROKER_ENV.socket} to the broker's Unix socket.`,
    );
  }
  return env[BROKER_ENV.socket] || BROKER_SOCKET_PATH;
}

export class BrokerClient {
  readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(options: BrokerClientOptions = {}) {
    this.socketPath = options.socketPath ?? brokerSocketPath(options.env ?? process.env);
    this.timeoutMs = options.timeoutMs ?? 60_000;
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
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: route,
          headers: data
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) }
            : {},
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
            const error = (body as { error?: { code?: unknown; message?: unknown } }).error;
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
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`no answer within ${Math.round(this.timeoutMs / 1000)} seconds`));
      });
      req.on("error", (err) => reject(this.unreachable(err)));
      req.end(data);
    });
  }

  private unreachable(err: Error): BrokerError {
    return new BrokerError(
      "unreachable",
      `Can't reach the secrets broker at ${this.socketPath}: ${err.message}. The Agent Box server might be stopped.`,
    );
  }
}
