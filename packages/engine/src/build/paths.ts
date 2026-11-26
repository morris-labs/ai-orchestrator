// Matching the paths that a build plan and its roles name: owned files, test
// paths, and role permission paths.
import { globToRegExp } from "../policy/glob.js";

/**
 * True when a build path is a glob: it has `*`, `?`, or a `{a,b}` group.
 * Brackets don't make a glob, since frameworks name folders such as
 * `app/[slug]`.
 */
export function isPathGlob(path: string): boolean {
  return /[*?{]/.test(path);
}

/**
 * Returns a test for repository-relative paths that `entries` cover. A path
 * matches an entry with the same text, and a glob entry as a pattern in
 * which `[` and `]` stand for themselves.
 */
export function pathMatcher(entries: readonly string[]): (path: string) => boolean {
  const exact = new Set(entries);
  const patterns = entries
    .filter((entry) => isPathGlob(entry))
    .map((glob) => globToRegExp(glob, { classes: false }));
  return (path) => exact.has(path) || patterns.some((re) => re.test(path));
}
