// ULIDs for run ids: 48 bits of milliseconds and 80 random bits in Crockford
// base 32, so ids sort by creation time.
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

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
