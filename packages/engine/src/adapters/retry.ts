// The design's failure policy: a stage retries a failed call once, then stops
// the run with a report. `RunContext.callAgent` runs the retry; this file
// says which failures earn it.
import { AdapterError, type AdapterErrorKind } from "./types.js";

/** Error kinds worth a second attempt. Limits, sign-in, and cancellation are not. */
export const RETRYABLE_KINDS: readonly AdapterErrorKind[] = ["timeout", "output", "process"];

export function isRetryable(error: unknown): boolean {
  return error instanceof AdapterError && RETRYABLE_KINDS.includes(error.kind);
}
