// The error the core throws for every failure that an API caller can act on.
// W2 turns it into the contract's `ApiError` body and status code.
import type { ApiErrorCode, ApiError as ApiErrorBody } from "@agentbox/contracts";

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
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }

  /** The HTTP status code for this error. */
  get status(): number {
    return API_ERROR_STATUS[this.code];
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
