// A client of the build socket, for the `aio-build` command. This module
// imports only Node built-ins and the contracts, so the command starts fast.
import http from "node:http";
import {
  ApiErrorSchema,
  BUILD_SOCKET_ENV,
  BUILD_SOCKET_PATH,
  BUILD_SOCKET_RESPONSES,
  BUILD_SOCKET_ROUTES,
  type ApiErrorCode,
  type BuildSocketAnswer,
  type BuildSocketRequestKind,
  type BuildState,
} from "@aio/contracts";

/**
 * Why a build request failed: `unreachable` when nothing answers at the
 * socket, `protocol` for an answer this client can't read, and otherwise
 * the engine's error code.
 */
export type BuildSocketErrorCode = "unreachable" | "protocol" | ApiErrorCode;

export class BuildSocketError extends Error {
  constructor(
    readonly code: BuildSocketErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "BuildSocketError";
  }
}

/** The socket path for this environment: `AIO_BUILD_SOCKET`, else `BUILD_SOCKET_PATH`. */
export function buildSocketPath(env: Record<string, string | undefined> = process.env): string {
  return env[BUILD_SOCKET_ENV.socket] || BUILD_SOCKET_PATH;
}

export class BuildSocketClient {
  constructor(
    readonly socketPath: string,
    private readonly timeoutMs = 60_000,
    /** Headers sent with every request, such as the session headers. */
    private readonly headers: Record<string, string> = {},
  ) {}

  /** Sends a start, status, pause, or resume request and returns the build's state after it. */
  async request(
    kind: Exclude<
      BuildSocketRequestKind,
      "plan" | "freeze" | "meet" | "meeting-post" | "messages" | "decisions" | "inbox"
    >,
    body: unknown,
  ): Promise<BuildState> {
    return (await this.send(kind, body)).build;
  }

  /** Sends one build request and returns its answer. */
  send<K extends BuildSocketRequestKind>(kind: K, body: unknown): Promise<BuildSocketAnswer<K>> {
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method: "POST",
          path: BUILD_SOCKET_ROUTES[kind],
          headers: {
            ...this.headers,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(data),
          },
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", (err) => reject(this.unreachable(err)));
          res.on("end", () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              reject(this.protocolError());
              return;
            }
            const ok = BUILD_SOCKET_RESPONSES[kind].safeParse(parsed);
            if (ok.success && (res.statusCode === 200 || res.statusCode === 201)) {
              resolve(ok.data as BuildSocketAnswer<K>);
              return;
            }
            const failed = ApiErrorSchema.safeParse(parsed);
            if (!failed.success) {
              reject(this.protocolError());
              return;
            }
            const { code, message, details } = failed.data.error;
            reject(new BuildSocketError(code, message, details));
          });
        },
      );
      const deadline = setTimeout(() => {
        req.destroy(new Error(`no answer within ${Math.round(this.timeoutMs / 1000)} seconds`));
      }, this.timeoutMs);
      req.on("close", () => clearTimeout(deadline));
      req.on("error", (err) => reject(this.unreachable(err)));
      req.end(data);
    });
  }

  private protocolError(): BuildSocketError {
    return new BuildSocketError(
      "protocol",
      `The build socket at ${this.socketPath} sent an answer this client can't read.`,
    );
  }

  private unreachable(err: Error): BuildSocketError {
    return new BuildSocketError(
      "unreachable",
      `Can't reach the build socket at ${this.socketPath}: ${err.message}. The engine might be stopped; check the box's container.`,
    );
  }
}
