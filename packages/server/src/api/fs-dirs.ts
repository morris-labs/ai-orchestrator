// `fs.dirs`: a host folder picker for the apps. It lists subdirectories only,
// never files, and takes only absolute paths (or `~`), so a caller can't
// reach anything relative to the server's working directory.
import fs from "node:fs/promises";
import path from "node:path";
import type { DirListing } from "@agentbox/contracts";
import { ApiError } from "./errors.js";

/**
 * Resolves the `path` query: absent means `home`, `~` and `~/...` resolve
 * against `home`, and anything else must be absolute. The result is
 * normalized, so `..` segments can't survive into the listing.
 */
export function resolveDirQuery(home: string, requested: string | undefined): string {
  if (requested === undefined || requested === "~") return path.resolve(home);
  if (requested.startsWith("~/")) return path.resolve(home, requested.slice(2));
  if (!path.isAbsolute(requested)) {
    throw new ApiError("validation", `${requested} is not an absolute path.`);
  }
  return path.resolve(requested);
}

/** Lists the subdirectories of a directory, sorted by name. Symbolic links to directories count. */
export async function listDirs(home: string, requested: string | undefined): Promise<DirListing> {
  const dir = resolveDirQuery(home, requested);
  let stat;
  try {
    stat = await fs.stat(dir);
  } catch {
    throw new ApiError("not_found", `${dir} does not exist.`);
  }
  if (!stat.isDirectory()) throw new ApiError("validation", `${dir} is not a directory.`);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new ApiError("validation", `${dir} can't be read: ${(err as Error).message}`);
  }
  const dirs: { name: string; path: string }[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      isDir = await fs.stat(full).then(
        (s) => s.isDirectory(),
        () => false,
      );
    }
    if (isDir) dirs.push({ name: entry.name, path: full });
  }
  dirs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, entries: dirs };
}
