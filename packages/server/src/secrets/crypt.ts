// SHA-512 crypt (`$6$`), the password hash glibc's crypt(3) and PAM accept
// in /etc/shadow. The server hashes the container user's sudo password on
// the host, so the plaintext never reaches a container. The algorithm
// follows Ulrich Drepper's specification, "Unix crypt using SHA-256 and
// SHA-512".
import crypto from "node:crypto";

const ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** The rounds the server uses: well above the 5000 default, still quick for sudo. */
export const SUDO_HASH_ROUNDS = 100_000;

/** A `$6$` hash with an explicit round count, as `sha512Crypt()` produces it. */
export const SHA512_CRYPT_PATTERN = /^\$6\$rounds=\d+\$[./0-9A-Za-z]{1,16}\$[./0-9A-Za-z]{86}$/;

const ROUNDS_MIN = 1000;
const ROUNDS_MAX = 999_999_999;
const ROUNDS_DEFAULT = 5000;

/** Byte triples of the final digest in the order the specification encodes them. */
const ORDER: readonly (readonly [number, number, number])[] = [
  [0, 21, 42],
  [22, 43, 1],
  [44, 2, 23],
  [3, 24, 45],
  [25, 46, 4],
  [47, 5, 26],
  [6, 27, 48],
  [28, 49, 7],
  [50, 8, 29],
  [9, 30, 51],
  [31, 52, 10],
  [53, 11, 32],
  [12, 33, 54],
  [34, 55, 13],
  [56, 14, 35],
  [15, 36, 57],
  [37, 58, 16],
  [59, 17, 38],
  [18, 39, 60],
  [40, 61, 19],
  [62, 20, 41],
];

function sha512(...parts: Buffer[]): Buffer {
  const h = crypto.createHash("sha512");
  for (const p of parts) h.update(p);
  return h.digest();
}

/** `len` bytes of `digest` repeated. */
function repeatTo(digest: Buffer, len: number): Buffer {
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i += 64) digest.copy(out, i, 0, Math.min(64, len - i));
  return out;
}

function encode24(b2: number, b1: number, b0: number, n: number): string {
  let w = (b2 << 16) | (b1 << 8) | b0;
  let s = "";
  for (let i = 0; i < n; i++) {
    s += ITOA64[w & 0x3f];
    w >>= 6;
  }
  return s;
}

/**
 * Hashes `password` with SHA-512 crypt. `salt` is cut to 16 characters, and
 * `rounds` is clamped to 1000 through 999999999. The result names the round
 * count unless it is the default, 5000, as crypt(3) does.
 */
export function sha512Crypt(
  password: string,
  salt: string,
  rounds: number = ROUNDS_DEFAULT,
): string {
  const r = Math.min(ROUNDS_MAX, Math.max(ROUNDS_MIN, Math.floor(rounds)));
  const p = Buffer.from(password, "utf8");
  const s = Buffer.from(salt.slice(0, 16), "utf8");

  const b = sha512(p, s, p);
  const a = crypto.createHash("sha512");
  a.update(p);
  a.update(s);
  let len = p.length;
  for (; len > 64; len -= 64) a.update(b);
  a.update(b.subarray(0, len));
  for (let bits = p.length; bits > 0; bits >>= 1) a.update(bits & 1 ? b : p);
  const aDigest = a.digest();

  const dp = crypto.createHash("sha512");
  for (let i = 0; i < p.length; i++) dp.update(p);
  const pSeq = repeatTo(dp.digest(), p.length);

  const ds = crypto.createHash("sha512");
  for (let i = 0; i < 16 + aDigest[0]!; i++) ds.update(s);
  const sSeq = repeatTo(ds.digest(), s.length);

  let c = aDigest;
  for (let i = 0; i < r; i++) {
    const h = crypto.createHash("sha512");
    h.update(i & 1 ? pSeq : c);
    if (i % 3) h.update(sSeq);
    if (i % 7) h.update(pSeq);
    h.update(i & 1 ? c : pSeq);
    c = h.digest();
  }

  let out = "";
  for (const [x, y, z] of ORDER) out += encode24(c[x]!, c[y]!, c[z]!, 4);
  out += encode24(0, 0, c[63]!, 2);
  const prefix = r === ROUNDS_DEFAULT ? "$6$" : `$6$rounds=${r}$`;
  return `${prefix}${s.toString("utf8")}$${out}`;
}

/** A random 16-character salt from the crypt alphabet. */
export function randomCryptSalt(): string {
  const bytes = crypto.randomBytes(16);
  let s = "";
  for (const byte of bytes) s += ITOA64[byte & 0x3f];
  return s;
}

/** Hashes a sudo password with a fresh salt and `SUDO_HASH_ROUNDS` rounds. */
export function hashSudoPassword(password: string): string {
  return sha512Crypt(password, randomCryptSalt(), SUDO_HASH_ROUNDS);
}
