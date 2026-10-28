// The engine's own version, from its package.json.
import { readFileSync } from "node:fs";

/** Reads `version` from the engine's package.json (two levels above this file in `src` and `dist`). */
export function readPackageVersion(): string {
  const url = new URL("../../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version === "") {
    throw new Error("The engine's package.json has no version.");
  }
  return pkg.version;
}
