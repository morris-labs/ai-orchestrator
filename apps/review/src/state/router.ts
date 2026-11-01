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

/** Decodes a path segment; a malformed escape such as `%E0%A4` stays as typed. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Parses `#/runs/ID?x=1` into a route. Unknown paths go to the launcher. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const [pathPart = "", queryPart = ""] = raw.split("?", 2);
  const parts = pathPart.split("/").filter(Boolean).map(decodeSegment);
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

/**
 * Moves a deep link in the page's own query string (`search`) into the
 * hash, so it applies once: to the Policy screen when the hash shows it,
 * else to the launcher. The page's URL loses the query, so later routes
 * don't see it. Does nothing without a deep link.
 */
export function moveDeepLinkToHash(search: string): void {
  const link = deepLink(search);
  if (!link.project && !link.box) return;
  const route = parseHash(window.location.hash);
  const machine = link.machine ?? undefined;
  const hash =
    route.name === "policy"
      ? href("/policy", {
          project: route.query.get("project") ?? link.project ?? undefined,
          machine,
        })
      : href("/launch", {
          project: link.project ?? undefined,
          box: link.box ?? undefined,
          machine,
        });
  history.replaceState(history.state, "", `${window.location.pathname}${hash}`);
}

/**
 * The deep link `?project=&box=&machine=` in the page's own query string.
 * `machine` names the machine that holds the box; `null` means this one.
 */
export function deepLink(search: string): {
  project: string | null;
  box: string | null;
  machine: string | null;
} {
  const q = new URLSearchParams(search);
  return { project: q.get("project"), box: q.get("box"), machine: q.get("machine") || null };
}

/** The machine a route's `machine` query names, or `null`. */
export function linkedMachine(route: Route): string | null {
  return route.query.get("machine") || null;
}
