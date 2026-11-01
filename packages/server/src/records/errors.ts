// The error the server throws for every failure that an API caller can act
// on, and the status code of each contract error code.
import type { ApiErrorCode, ApiError as ApiErrorBody } from "@aio/contracts";

/** The HTTP status for each contract error code. */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
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

/**
 * The one error class for a failure an API caller can act on. Throw it from
 * any service; the API layer answers with `status` and `toBody()`.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details: unknown;
  /** The HTTP status code: the code's usual status unless the constructor overrides it. */
  readonly status: number;

  /**
   * `status` overrides the code's usual status, such as 502 for an
   * `internal` failure that an engine caused.
   */
  constructor(code: ApiErrorCode, message: string, details?: unknown, status?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
    this.status = status ?? API_ERROR_STATUS[code];
  }

  /** The contract's JSON body for this error. */
  toBody(): ApiErrorBody {
    const error: ApiErrorBody["error"] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

/** Throws `not_found` with a sentence naming the missing thing. */
export function notFound(what: string): never {
  throw new ApiError("not_found", `${what} does not exist.`);
}

/** Returns the message of any thrown value. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
