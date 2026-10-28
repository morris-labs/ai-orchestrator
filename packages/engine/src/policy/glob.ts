// A small glob matcher for policy paths: `**`, `*`, `?`, `{a,b}`, and `[...]`.

const cache = new Map<string, RegExp>();

/** Converts a glob to an anchored regular expression over `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let re = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atStart = i === 0 || glob[i - 1] === "/";
        const atEnd = i + 2 === glob.length || glob[i + 2] === "/";
        i += 1;
        if (atStart && atEnd) {
          if (glob[i + 1] === "/") {
            i += 1;
            re += "(?:.*/)?";
          } else {
            re += ".*";
          }
          continue;
        }
        re += ".*";
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      braces += 1;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces -= 1;
      re += ")";
    } else if (c === "," && braces > 0) re += "|";
    else if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) re += "\\[";
      else {
        re += `[${glob.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  const result = new RegExp(`^${re}$`);
  cache.set(glob, result);
  return result;
}

/**
 * True when `path` matches `glob`. A glob without a `/` also matches the
 * file name in any directory, as in `.gitignore`.
 */
export function matchesGlob(path: string, glob: string): boolean {
  const normalized = path.replace(/^\.\//, "");
  if (globToRegExp(glob).test(normalized)) return true;
  if (!glob.includes("/")) {
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    return globToRegExp(glob).test(name);
  }
  // A directory glob such as `src/auth/` or `src/auth` covers everything under it.
  const dir = glob.replace(/\/+$/, "");
  return !/[*?[{]/.test(dir) && (normalized === dir || normalized.startsWith(`${dir}/`));
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => matchesGlob(path, g));
}
