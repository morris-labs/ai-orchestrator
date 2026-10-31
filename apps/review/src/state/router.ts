// Hash routing, so the app works under `/review/` on the server, in Vite's
// dev server, and in Electron without server-side rewrites.
import { useEffect, useRef, useState } from "react";

export type RouteName =
  "launch" | "runs" | "run" | "findings" | "dashboard" | "policy" | "settings";

export interface Route {
  name: RouteName;
  params: Record<string, string>;
  query: URLSearchParams;
}

/** Parses `#/runs/ID?x=1` into a route. Unknown paths go to the launcher. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [pathPart = "", queryPart = ""] = raw.split("?", 2);
  const parts = pathPart.split("/").filter(Boolean).map(decodeURIComponent);
  const query = new URLSearchParams(queryPart);
  const [head, id] = parts;
  switch (head) {
    case "runs":
      return id
        ? { name: "run", params: { runId: id }, query }
        : { name: "runs", params: {}, query };
    case "findings":
    case "dashboard":
    case "policy":
    case "settings":
    case "launch":
      return { name: head, params: {}, query };
    default:
      return { name: "launch", params: {}, query };
  }
}

export function href(path: string, query?: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v) q.set(k, v);
  const s = q.toString();
  return `#${path}${s ? `?${s}` : ""}`;
}

export function navigate(to: string): void {
  window.location.hash = to.replace(/^#/, "");
}

let leaveGuard: (() => boolean) | null = null;

/**
 * Installs a check that runs before the route changes, such as "discard
 * unsaved changes?". It returns false to keep the current route. Returns a
 * function that removes the check.
 */
export function setLeaveGuard(guard: () => boolean): () => void {
  leaveGuard = guard;
  return () => {
    if (leaveGuard === guard) leaveGuard = null;
  };
}

export function useRoute(): Route {
  const [hash, setHash] = useState(() => window.location.hash);
  const current = useRef(hash);
  useEffect(() => {
    const on = () => {
      const next = window.location.hash;
      if (next === current.current) return;
      if (leaveGuard && !leaveGuard()) {
        // Put the old hash back without another hashchange.
        history.replaceState(history.state, "", current.current || "#");
        return;
      }
      current.current = next;
      setHash(next);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parseHash(hash);
}

/** The deep link `?project=&box=` in the page's own query string. */
export function deepLink(search: string): { project: string | null; box: string | null } {
  const q = new URLSearchParams(search);
  return { project: q.get("project"), box: q.get("box") };
}
