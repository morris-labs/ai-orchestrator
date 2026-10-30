// Reads a file of the working tree by a path that came from a diff or from a
// reviewer's finding. A reviewer's path is model output, so it is confined to
// the repository: no absolute path, no `..`, no symbolic link out, and only a
// regular file of a bounded size.
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** The largest file the engine reads from the working tree, in bytes. */
export const MAX_REPO_FILE_BYTES = 4 * 1024 * 1024;

/**
 * The content of `path` under `root`, or `null` when the path leaves the
 * repository, isn't a regular file, is larger than `maxBytes`, or can't be
 * read.
 */
export async function readRepoFile(
  root: string,
  path: string,
  maxBytes = MAX_REPO_FILE_BYTES,
): Promise<string | null> {
  if (path === "" || path.includes("\0") || isAbsolute(path)) return null;
  try {
    const realRoot = await realpath(root);
    const real = await realpath(resolve(root, path));
    const rel = relative(realRoot, real);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    const info = await stat(real);
    if (!info.isFile() || info.size > maxBytes) return null;
    return await readFile(real, "utf8");
  } catch {
    return null;
  }
}
