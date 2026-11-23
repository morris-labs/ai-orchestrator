// Build ids: a ULID names a build on leases and agent events, which validate
// the caller's id as a run id. The slug names the build everywhere else.
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48 bits of milliseconds and 80 random bits in Crockford base 32. */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let random = "";
  for (let i = 0; i < 16; i += 1) random += ALPHABET[(bytes[i] as number) % 32];
  return time + random;
}
