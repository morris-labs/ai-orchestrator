// The terminal tab strip: which tabs are open, which is current, and the
// Qt rules for reusing a live tab and replacing an ended one.
import type { Platform } from "@aio/contracts";

export interface Tab {
  /** Unique per tab, so a replaced tab gets a fresh terminal. */
  key: string;
  boxId: string;
  /** The main session, a side session, or a shell in the container. */
  kind: "session" | "side" | "shell";
  platform?: Platform;
  title: string;
  tooltip: string;
  ended: boolean;
  exitCode: number | null;
}

export interface TabsState {
  tabs: Tab[];
  current: string | null;
}

export const emptyTabs: TabsState = { tabs: [], current: null };

let counter = 0;

function sameTarget(t: Tab, boxId: string, kind: Tab["kind"], platform?: Platform) {
  return t.boxId === boxId && t.kind === kind && t.platform === platform;
}

/**
 * Opens a tab for a box. A live tab for the same target is reused; an ended
 * one is replaced in place by a new terminal.
 */
export function openTab(
  state: TabsState,
  target: {
    boxId: string;
    kind?: Tab["kind"];
    platform?: Platform;
    title: string;
    tooltip?: string;
  },
): TabsState {
  const kind = target.kind ?? "session";
  const existing = state.tabs.find((t) => sameTarget(t, target.boxId, kind, target.platform));
  if (existing && !existing.ended) return { ...state, current: existing.key };
  counter += 1;
  const tab: Tab = {
    key: `tab-${counter}`,
    boxId: target.boxId,
    kind,
    title: target.title,
    tooltip: target.tooltip ?? target.boxId,
    ended: false,
    exitCode: null,
    ...(target.platform ? { platform: target.platform } : {}),
  };
  if (existing) {
    return { tabs: state.tabs.map((t) => (t.key === existing.key ? tab : t)), current: tab.key };
  }
  return { tabs: [...state.tabs, tab], current: tab.key };
}

/** Closes a tab; the next tab to the right (or else the left) becomes current. */
export function closeTab(state: TabsState, key: string): TabsState {
  const i = state.tabs.findIndex((t) => t.key === key);
  if (i < 0) return state;
  const tabs = state.tabs.filter((t) => t.key !== key);
  let current = state.current;
  if (current === key) current = (tabs[i] ?? tabs[i - 1])?.key ?? null;
  return { tabs, current };
}

export function closeOthers(state: TabsState, key: string): TabsState {
  return { tabs: state.tabs.filter((t) => t.key === key), current: key };
}

/** Closes every tab of a box, as Stop does. */
export function closeBoxTabs(state: TabsState, boxId: string): TabsState {
  let s = state;
  for (const t of state.tabs.filter((x) => x.boxId === boxId)) s = closeTab(s, t.key);
  return s;
}

/** Marks a tab ended: it keeps its screen and gets " (ended)" in its title. */
export function markEnded(state: TabsState, key: string, exitCode: number | null): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.key === key ? { ...t, ended: true, exitCode } : t)),
  };
}

export function tabTitle(t: Tab): string {
  return t.ended ? `${t.title} (ended)` : t.title;
}

/** Steps to the next (`+1`) or previous (`-1`) tab, wrapping. */
export function stepTab(state: TabsState, delta: number): TabsState {
  if (state.tabs.length === 0) return state;
  const i = state.tabs.findIndex((t) => t.key === state.current);
  const n = state.tabs.length;
  const next = state.tabs[((((i < 0 ? 0 : i) + delta) % n) + n) % n] as Tab;
  return { ...state, current: next.key };
}

/** Picks tab N (1-based), as Alt+1 to Alt+9 do. */
export function pickTab(state: TabsState, n: number): TabsState {
  const t = state.tabs[n - 1];
  return t ? { ...state, current: t.key } : state;
}

/**
 * Keeps tab titles on the conversation name after a rename: a session tab
 * shows the name, a side tab the name and its platform, and a shell tab the
 * name and "(shell)". `names` maps box ids
 * to display names; `sideLabel` names a platform. Returns `state` itself when
 * no title changes.
 */
export function syncTitles(
  state: TabsState,
  names: ReadonlyMap<string, string>,
  sideLabel: (p: Platform) => string,
): TabsState {
  let changed = false;
  const tabs = state.tabs.map((t) => {
    const name = names.get(t.boxId);
    if (name === undefined) return t;
    const title =
      t.kind === "side" && t.platform
        ? `${name} (${sideLabel(t.platform)})`
        : t.kind === "shell"
          ? `${name} (shell)`
          : name;
    if (title === t.title) return t;
    changed = true;
    return { ...t, title };
  });
  return changed ? { ...state, tabs } : state;
}
