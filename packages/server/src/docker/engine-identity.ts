// The engine identity the server expects in the image.
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Where the build writes the content hash of the engine: `dist/identity` in
 * the engine package of a source checkout, and `dist/engine-identity` in an
 * image build context (scripts/build-image.sh copies it there). The checkout
 * comes first, because it can be newer than the last packed context.
 */
export function engineIdentityFiles(repoRoot: string, imageContext: string): string[] {
  return [
    path.join(repoRoot, "packages", "engine", "dist", "identity"),
    path.join(imageContext, "dist", "engine-identity"),
  ];
}

/**
 * The engine version the server expects: `version+HASH` when one of the
 * files holds a hash, else the plain `version`. An image built before the
 * hash existed records the plain version, so it reads as stale once the
 * server finds a hash.
 */
export function expectedEngineVersion(
  version: string,
  files: string[],
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
): string {
  for (const file of files) {
    let text: string;
    try {
      text = read(file).trim();
    } catch {
      continue;
    }
    if (/^[0-9a-f]{8,64}$/.test(text)) return `${version}+${text}`;
  }
  return version;
}
