// API errors: an `ApiFailure` carries a contract error code, and the API
// layer turns it into the status code and `ApiError` body the contracts
// define.
import { ApiErrorCodeSchema, type ApiError, type ApiErrorCode } from "@agentbox/contracts";
import { ZodError } from "zod";

/** The HTTP status for each error code, as `common.ts` documents them. */
export const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
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

/** An error with a contract error code. Throw it from any service the API calls. */
export class ApiFailure extends Error {
  readonly code: ApiErrorCode;
  readonly details: unknown;
  readonly status: number;

  /**
   * `status` overrides the code's usual status. The API uses 500 with code
   * `conflict` for an unexpected error, because the contract list has no
   * internal-error code.
   */
  constructor(code: ApiErrorCode, message: string, details?: unknown, status?: number) {
    super(message);
    this.name = "ApiFailure";
    this.code = code;
    this.details = details;
    this.status = status ?? STATUS_BY_CODE[code];
  }

  toBody(): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** Returns true when `value` names a contract error code. */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return ApiErrorCodeSchema.safeParse(value).success;
}

/**
 * Turns any thrown value into an `ApiFailure`. An error from another module
 * counts when it has a `code` property that names a contract error code, so
 * the server core does not need to import this class.
 */
export function toApiFailure(err: unknown): ApiFailure {
  if (err instanceof ApiFailure) return err;
  if (err instanceof ZodError) {
    return new ApiFailure("validation", "The request doesn't match its schema.", err.issues);
  }
  if (err instanceof Error) {
    const { code, details } = err as Error & { code?: unknown; details?: unknown };
    if (isApiErrorCode(code)) return new ApiFailure(code, err.message, details);
    return new ApiFailure("conflict", err.message, undefined, 500);
  }
  return new ApiFailure("conflict", String(err), undefined, 500);
}
