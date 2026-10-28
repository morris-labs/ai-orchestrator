// API errors: an `ApiError` carries a contract error code, and the API layer
// turns it into the status code and `ApiError` body the contracts define.
import { ApiErrorCodeSchema, type ApiErrorCode } from "@agentbox/contracts";
import { ZodError } from "zod";
import { API_ERROR_STATUS, ApiError } from "../records/errors.js";

export { ApiError };

/** The HTTP status for each error code, as `common.ts` documents them. */
export const STATUS_BY_CODE: Record<ApiErrorCode, number> = API_ERROR_STATUS;

/** Returns true when `value` names a contract error code. */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return ApiErrorCodeSchema.safeParse(value).success;
}

/**
 * Turns any thrown value into an `ApiError`. An error of another class
 * counts when it has a `code` property that names a contract error code.
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) {
    return new ApiError("validation", "The request doesn't match its schema.", err.issues);
  }
  if (err instanceof Error) {
    const { code, details } = err as Error & { code?: unknown; details?: unknown };
    if (isApiErrorCode(code)) return new ApiError(code, err.message, details);
    return new ApiError("internal", err.message);
  }
  return new ApiError("internal", String(err));
}
