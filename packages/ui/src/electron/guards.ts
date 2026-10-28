// Checks the Electron main processes apply before they trust a page, open a
// link, or open a path. Kept free of Electron so that tests run them under
// Node.

/**
 * True when `url` is one of the app's own pages. A page counts when it has
 * the same origin as an entry of `appPages` and its path starts with that
 * entry's path. A `file:` entry matches only that exact file, whatever the
 * query or hash.
 */
export function isAppPage(url: string, appPages: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return appPages.some((page) => {
    let p: URL;
    try {
      p = new URL(page);
    } catch {
      return false;
    }
    if (p.protocol === "file:") return u.protocol === "file:" && u.pathname === p.pathname;
    if (u.protocol !== p.protocol || u.host !== p.host) return false;
    const base = p.pathname.endsWith("/") ? p.pathname : `${p.pathname}/`;
    return u.pathname === p.pathname || `${u.pathname}/` === base || u.pathname.startsWith(base);
  });
}

/** True for an `http:` or `https:` URL, the only kind the apps hand to the desktop. */
export function isWebUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/**
 * True when `path` is an absolute path equal to one of `allowed`, the
 * directories the server reported (project roots and box directories).
 * Trailing slashes don't count; `..` segments never match.
 */
export function isAllowedOpenPath(path: string, allowed: readonly string[]): boolean {
  if (typeof path !== "string" || !path.startsWith("/")) return false;
  if (path.split("/").some((seg) => seg === "..")) return false;
  const p = trimSlash(path);
  return allowed.some((a) => a !== "" && trimSlash(a) === p);
}
