// The engine's own identity: its package version plus a content hash.
import { readFileSync } from "node:fs";

/**
 * Joins a package version and the content hash that `scripts/write-identity.mjs`
 * writes to `dist/identity`. Without a hash, as when tests run from `src`, the
 * identity is the plain version.
 */
export function engineIdentity(version: string, hash: string | null): string {
  const h = hash?.trim() ?? "";
  return h === "" ? version : `${version}+${h}`;
}

/**
 * Reads the engine identity: `version` from the engine's package.json (two
 * levels above this file in `src` and `dist`), plus `+HASH` when the build
 * wrote `dist/identity`. Every build shares one package version, so the hash
 * is what tells a stale engine from a current one.
 */
export function readPackageVersion(): string {
  const url = new URL("../../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version === "") {
    throw new Error("The engine's package.json has no version.");
  }
  let hash: string | null = null;
  try {
    hash = readFileSync(new URL("../identity", import.meta.url), "utf8");
  } catch {
    // A source checkout that hasn't built has no identity file.
  }
  return engineIdentity(pkg.version, hash);
}
