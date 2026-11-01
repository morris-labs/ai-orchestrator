// The secrets broker's protocol: HTTP/1.1 with JSON bodies over a Unix
// socket that the server opens for each project container and mounts into
// it. The engine and the `aio-secret` client in the image speak it.
// See `docs/secrets.md`.
import { z } from "zod";
import { ApiErrorCodeSchema, EnvVarNameSchema } from "./common.js";

/** Where the server mounts a container's broker directory, read-only. */
export const BROKER_MOUNT = "/run/aio-broker";

/** The socket's file name in the broker directory. */
export const BROKER_SOCKET_NAME = "broker.sock";

/** The socket path inside a container. */
export const BROKER_SOCKET_PATH = `${BROKER_MOUNT}/${BROKER_SOCKET_NAME}`;

/** Environment variables that tell a client where the broker is. */
export const BROKER_ENV = {
  /** The socket path; the client falls back to `BROKER_SOCKET_PATH`. */
  socket: "AIO_BROKER_SOCKET",
  /**
   * A TCP broker URL for Docker Desktop, where a host socket can't be
   * mounted. Reserved: the server never sets it, and the client refuses it
   * until the TCP transport exists.
   */
  url: "AIO_BROKER_URL",
} as const;

/** The broker's routes. */
export const BROKER_ROUTES = {
  names: "/v1/names",
  read: "/v1/read",
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
 * The error codes the broker returns: `not_found` for a name the project
 * doesn't list, `secrets_locked` and `secrets_unavailable` as in the server
 * API, `validation` for a malformed request, and `internal`.
 */
export const BrokerErrorCodeSchema = ApiErrorCodeSchema.extract([
  "not_found",
  "secrets_locked",
  "secrets_unavailable",
  "validation",
  "internal",
]);
export type BrokerErrorCode = z.infer<typeof BrokerErrorCodeSchema>;
