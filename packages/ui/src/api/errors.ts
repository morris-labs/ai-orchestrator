// Errors that the API client raises.
import { ApiErrorSchema, type ApiErrorCode } from "@aio/contracts";

/**
 * The client-side codes on top of the server's `ApiErrorCode` list:
 * `unreachable` when no response arrives, and `bad_response` when a
 * response doesn't match its contract schema.
 */
export type ClientErrorCode = ApiErrorCode | "unreachable" | "bad_response";

/** A failed API call, with the server's error code and message. */
export class ApiRequestError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: ClientErrorCode, message: string, status = 0, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** Builds the error from a failed response's status and parsed JSON body. */
  static fromResponse(status: number, body: unknown): ApiRequestError {
    const parsed = ApiErrorSchema.safeParse(body);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      return new ApiRequestError(code, message, status, details);
    }
    return new ApiRequestError(
      "bad_response",
      `The server answered with status ${status} and an unexpected body.`,
      status,
      body,
    );
  }
}

/** Returns true when `err` is an `ApiRequestError` with one of `codes`. */
export function isApiError(err: unknown, ...codes: ClientErrorCode[]): err is ApiRequestError {
  return err instanceof ApiRequestError && (codes.length === 0 || codes.includes(err.code));
}

/** A one-line description of any thrown value, for a message box or a toast. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
