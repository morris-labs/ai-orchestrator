// Maps engine errors to `ApiError` bodies and HTTP status codes.
import { ApiErrorCodeSchema, type ApiError, type ApiErrorCode } from "@agentbox/contracts";
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
 * - Anything else becomes a 500. The contract has no internal-error code,
 *   so the body uses `conflict` and a generic message; the cause goes to the
 *   log, not to the client.
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
  }
  return {
    status: 500,
    body: { error: { code: "conflict", message: "The engine failed to handle the request." } },
  };
}
