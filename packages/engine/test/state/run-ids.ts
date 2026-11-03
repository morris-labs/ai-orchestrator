// Run ids for tests. The engine names temporary checkouts after the run id, so
// a repeated id lets test files running at once remove each other's checkouts.
import { randomInt } from "node:crypto";

const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A run id that no other test file or test process uses. */
export function uniqueRunId(): string {
  let id = "01JD";
  while (id.length < 26) id += ULID_CHARS[randomInt(ULID_CHARS.length)];
  return id;
}
