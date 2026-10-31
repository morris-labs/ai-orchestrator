// Writes dist/identity: a short content hash of the built engine.
//
// Every build of the engine calls itself by the same package version, so the
// version alone can't tell a current image from a stale one. The build
// scripts run this file after tsc. The engine appends the hash to its
// version, scripts/build-image.sh records it in the image, and the server
// expects it. The hash covers every file under dist/ except identity.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Lists the files under `dir`, as sorted POSIX-style relative paths. */
function listFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else if (rel !== "identity") out.push(rel);
  }
  return out.sort();
}

/** Hashes the names and contents of the files under `dir`. */
export function hashDist(dir) {
  const hash = createHash("sha256");
  for (const rel of listFiles(dir)) {
    hash.update(`${rel}\0`);
    hash.update(readFileSync(path.join(dir, rel)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
  writeFileSync(path.join(dist, "identity"), `${hashDist(dist)}\n`);
}
