// The secrets broker's protocol: HTTP/1.1 with JSON bodies, over a Unix
// socket that the server opens for each project container and mounts into
// it, or, under Docker Desktop, over TCP on the host's loopback address with
// a bearer token. The engine and the `aio-secret` client in the image speak
// it, and the `aio-box-review` client uses its review routes to start a
// review run of a box's own branch. See `docs/secrets.md`.
import { z } from "zod";
import { ApiErrorCodeSchema, EnvVarNameSchema } from "./common.js";
import { FindingSchema } from "./findings.js";
import { ProfileSchema, RunDepthSchema, RunStateSchema } from "./runs.js";

/** Where the server mounts a container's broker directory, read-only. */
export const BROKER_MOUNT = "/run/aio-broker";

/** The socket's file name in the broker directory. */
export const BROKER_SOCKET_NAME = "broker.sock";

/** The socket path inside a container. */
export const BROKER_SOCKET_PATH = `${BROKER_MOUNT}/${BROKER_SOCKET_NAME}`;

/**
 * The bearer token file of the TCP transport, in the broker directory. The
 * server writes a fresh random token, mode 0600, each time it creates the
 * container.
 */
export const BROKER_TOKEN_NAME = "broker.token";

/** The token file path inside a container. */
export const BROKER_TOKEN_PATH = `${BROKER_MOUNT}/${BROKER_TOKEN_NAME}`;

/**
 * The file in the broker directory that holds the TCP broker's URL. A client
 * reads it when its environment names no broker, because the engine
 * withholds every `AIO_` variable from the processes it starts.
 */
export const BROKER_URL_NAME = "broker.url";

/** The URL file path inside a container. */
export const BROKER_URL_PATH = `${BROKER_MOUNT}/${BROKER_URL_NAME}`;

/** The host name a container reaches the TCP broker at. */
export const BROKER_TCP_HOST = "host.docker.internal";

/** The address the TCP broker listens on. Never another address. */
export const BROKER_TCP_BIND = "127.0.0.1";

/** The URL a container reaches the TCP broker at, for the broker's host port. */
export function brokerTcpUrl(port: number): string {
  return `http://${BROKER_TCP_HOST}:${port}`;
}

/** Environment variables that tell a client where the broker is. */
export const BROKER_ENV = {
  /** The socket path; the client falls back to `BROKER_SOCKET_PATH`. */
  socket: "AIO_BROKER_SOCKET",
  /**
   * The TCP broker's URL, `http://host.docker.internal:PORT`, which the
   * server sets in place of `socket` under Docker Desktop, where a host
   * socket can't be mounted. The client sends the token in
   * `BROKER_TOKEN_PATH` with each request.
   */
  url: "AIO_BROKER_URL",
} as const;

/**
 * How the broker reaches a container:
 *
 * - `auto`: a Unix socket with a native Docker engine on Linux, and TCP when
 *   the engine is Docker Desktop or the server runs on macOS or Windows.
 * - `unix`: always the Unix socket.
 * - `tcp`: always TCP on the host's loopback address, with a bearer token.
 */
export const BrokerTransportSettingSchema = z.enum(["auto", "unix", "tcp"]);
export type BrokerTransportSetting = z.infer<typeof BrokerTransportSettingSchema>;

/** The transport one container uses: `auto` resolved. */
export type BrokerTransport = Exclude<BrokerTransportSetting, "auto">;

/** The broker's routes. */
export const BROKER_ROUTES = {
  names: "/v1/names",
  read: "/v1/read",
  /** `POST`: starts a review run of a box's own branch. See `BrokerReviewStartRequestSchema`. */
  reviewStart: "/v1/review/start",
  /**
   * `GET /v1/review/runs/RUN_ID?boxId=BOX_ID`: the run that box started,
   * with its findings. See `BrokerReviewRunResponseSchema`.
   */
  reviewRuns: "/v1/review/runs",
} as const;

/** The most names one read request can ask for. */
export const BROKER_MAX_NAMES = 64;

/** The largest request body the broker reads, in bytes. */
export const BROKER_MAX_BODY_BYTES = 16 * 1024;

/** The response of `GET /v1/names`: the names the container may request. */
export const BrokerNamesResponseSchema = z.object({
  names: z.array(EnvVarNameSchema),
});
export type BrokerNamesResponse = z.infer<typeof BrokerNamesResponseSchema>;

/** The body of `POST /v1/read`. */
export const BrokerReadRequestSchema = z
  .object({
    names: z.array(EnvVarNameSchema).min(1).max(BROKER_MAX_NAMES),
    /** Free text for the log, such as the client's command line. Never trusted. */
    caller: z.string().max(500).optional(),
  })
  .strict();
export type BrokerReadRequest = z.infer<typeof BrokerReadRequestSchema>;

/** The response of `POST /v1/read`: one value for each requested name. */
export const BrokerReadResponseSchema = z.object({
  values: z.record(EnvVarNameSchema, z.string()),
});
export type BrokerReadResponse = z.infer<typeof BrokerReadResponseSchema>;

/**
 * The body of `POST /v1/review/start`: a review run of the box's own branch,
 * in the project whose container sent the request. The server takes the
 * project from the socket or token, and the repository and branch from the
 * box's record, and refuses a box of another project or another branch.
 */
export const BrokerReviewStartRequestSchema = z
  .object({
    /** The asking box: `AIO_BOX_ID` in its session. */
    boxId: z.string().min(1).max(200),
    /**
     * The branch to review. It must be the box's own branch; absent means
     * that branch, or for a box without one, its checked-out branch.
     */
    branch: z.string().min(1).max(500).optional(),
    /** The base ref, as for `runs.create`. Default: `origin/main`. */
    base: z.string().min(1).max(500).optional(),
    /** Review without fixing. Default: false. */
    readOnly: z.boolean().optional(),
    profile: ProfileSchema.optional(),
    depth: RunDepthSchema.optional(),
  })
  .strict();
export type BrokerReviewStartRequest = z.infer<typeof BrokerReviewStartRequestSchema>;

/** The response of `GET /v1/review/runs/RUN_ID`: the run and its findings. */
export const BrokerReviewRunResponseSchema = z.object({
  run: RunStateSchema,
  findings: z.array(FindingSchema),
});
export type BrokerReviewRunResponse = z.infer<typeof BrokerReviewRunResponseSchema>;

/**
 * The error codes the broker returns: `not_found` for a name the project
 * doesn't list or a box outside the project, `secrets_locked` and
 * `secrets_unavailable` as in the server API, `validation` for a malformed
 * request or another branch, `unauthorized` for a TCP request without the
 * right bearer token, `run_not_found`, `conflict`, and `engine_mismatch` for
 * a review request the project's engine can't take, and `internal`.
 */
export const BrokerErrorCodeSchema = ApiErrorCodeSchema.extract([
  "not_found",
  "run_not_found",
  "conflict",
  "engine_mismatch",
  "unauthorized",
  "secrets_locked",
  "secrets_unavailable",
  "validation",
  "internal",
]);
export type BrokerErrorCode = z.infer<typeof BrokerErrorCodeSchema>;
