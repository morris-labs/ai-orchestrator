// The design's failure policy: a stage retries a failed call once, then stops
// the run with a report.
import { AdapterError, type AdapterErrorKind } from "./types.js";

/** Error kinds worth a second attempt. Limits, sign-in, and cancellation are not. */
export const RETRYABLE_KINDS: readonly AdapterErrorKind[] = ["timeout", "output", "process"];

export function isRetryable(error: unknown): boolean {
  return error instanceof AdapterError && RETRYABLE_KINDS.includes(error.kind);
}

export interface RetryOptions {
  /** Called before the second attempt with the first error. */
  onRetry?: (error: unknown) => void;
  shouldRetry?: (error: unknown) => boolean;
}

/** Runs `call`; on a retryable failure runs it once more and returns or throws that result. */
export async function retryOnce<T>(
  call: (attempt: 1 | 2) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  try {
    return await call(1);
  } catch (error) {
    if (!(opts.shouldRetry ?? isRetryable)(error)) throw error;
    opts.onRetry?.(error);
    return call(2);
  }
}
