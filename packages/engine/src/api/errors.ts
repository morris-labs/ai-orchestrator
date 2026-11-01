// Maps engine errors to `ApiError` bodies and HTTP status codes.
import { ApiErrorCodeSchema, type ApiError, type ApiErrorCode } from "@aio/contracts";
import { ZodError } from "zod";

const STATUS: Record<ApiErrorCode, number> = {
  adoption_refused: 409,
  session_tracked: 409,
  box_running: 409,
  stale_mounts: 409,
  secrets_locked: 503,
  secrets_unavailable: 503,
  engine_mismatch: 409,
  dirty_tree: 409,
  worktree_refused: 409,
  not_found: 404,
  conflict: 409,
  validation: 400,
  docker_unavailable: 503,
  image_missing: 409,
  run_not_found: 404,
  invalid_state: 409,
  unauthorized: 401,
  hub_unreachable: 503,
  internal: 500,
  machine_offline: 503,
  machine_timeout: 504,
};

/** The HTTP status for an error code. */
export function statusFor(code: ApiErrorCode): number {
  return STATUS[code];
}

export interface MappedError {
  status: number;
  body: ApiError;
}

/**
 * Turns anything thrown by a handler into a status and an `ApiError` body.
 *
 * - An error with a `code` from `ApiErrorCode` keeps its code and message.
 * - A `ZodError` becomes `validation` (400) with the issues in `details`.
 * - A Fastify error about the request (an `FST_` code with a 4xx
 *   `statusCode`, such as a body over the size limit) becomes `validation`
 *   with Fastify's status and message.
 * - Anything else becomes `internal` (500) with a generic message; the
 *   cause goes to the log, not to the client.
 */
export function mapError(err: unknown): MappedError {
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "validation",
          message: "The request doesn't match its schema.",
          details: err.issues,
        },
      },
    };
  }
  if (typeof err === "object" && err !== null && "code" in err) {
    const parsed = ApiErrorCodeSchema.safeParse((err as { code: unknown }).code);
    if (parsed.success) {
      const e = err as { message?: unknown; details?: unknown };
      const message = typeof e.message === "string" && e.message !== "" ? e.message : parsed.data;
      const body: ApiError = { error: { code: parsed.data, message } };
      if (e.details !== undefined) body.error.details = e.details;
      return { status: statusFor(parsed.data), body };
    }
    const fastify = fastifyClientError(err);
    if (fastify) return fastify;
  }
  return {
    status: 500,
    body: { error: { code: "internal", message: "The engine failed to handle the request." } },
  };
}

/**
 * A Fastify error that blames the request, such as
 * `FST_ERR_CTP_BODY_TOO_LARGE` (413), as `validation` with Fastify's own
 * status. Only `FST_` codes count: another library's error with a 4xx
 * status is the engine's failure, not the client's.
 */
function fastifyClientError(err: object): MappedError | null {
  const e = err as { code?: unknown; statusCode?: unknown; message?: unknown };
  if (typeof e.code !== "string" || !e.code.startsWith("FST_")) return null;
  const status = e.statusCode;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 499)
    return null;
  const message =
    typeof e.message === "string" && e.message !== "" ? e.message : "The request is invalid.";
  return { status, body: { error: { code: "validation", message } } };
}
