// SHA-512 crypt against the specification's vectors and `openssl passwd -6`.
import { describe, expect, it } from "vitest";
import {
  SHA512_CRYPT_PATTERN,
  SUDO_HASH_ROUNDS,
  hashSudoPassword,
  randomCryptSalt,
  sha512Crypt,
} from "../../src/secrets/crypt.js";

describe("sha512Crypt", () => {
  it("matches the specification's vectors", () => {
    expect(sha512Crypt("Hello world!", "saltstring")).toBe(
      "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1",
    );
    expect(sha512Crypt("Hello world!", "saltstringsaltstring", 10000)).toBe(
      "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.",
    );
  });

  it("matches openssl passwd -6 for a password longer than 64 bytes with non-ASCII text", () => {
    expect(
      sha512Crypt(
        "pässwörd-with-a-very-long-tail-that-exceeds-sixty-four-bytes-in-length-xx",
        "SYNTHsalt",
      ),
    ).toBe(
      "$6$SYNTHsalt$4RIbRZ5ML47UyjTonESy5kvQj.JrJUPaAOiaqjp4MxOOlMTitanlbS7rZKKm5hF.zZ3fX6Z2DNiG1aWrVWhaY/",
    );
  });

  it("hashes a sudo password with a fresh salt and the server's round count", () => {
    expect(randomCryptSalt()).toMatch(/^[./0-9A-Za-z]{16}$/);
    const a = hashSudoPassword("SYNTHETIC_PASSWORD");
    const b = hashSudoPassword("SYNTHETIC_PASSWORD");
    expect(a).toMatch(SHA512_CRYPT_PATTERN);
    expect(a.startsWith(`$6$rounds=${SUDO_HASH_ROUNDS}$`)).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain("SYNTHETIC_PASSWORD");
  });
});
