// The shared Claude transcript store (option S of `docs/v4/design-accounts.md`,
// decision S): one folder, `DATA_DIR/transcripts/claude`, so that
// `~/.claude-box` is the only folder in the home directory that Agent Box
// uses for its own data. Every Claude account's `projects` entry is a
// symbolic link to it, and in host mode the host's `~/.claude/projects`
// leads to it, possibly through other links (`agentbox transcripts adopt`
// sets that up). Resume, fork, the conversation picker, Purge, and Move work
// whichever account a box uses.
import fs from "node:fs";
import path from "node:path";
import { dataDirOf, type HostEnv } from "../records/env.js";

type StoreEnv = Pick<HostEnv, "home" | "dataDir">;

/** `DATA_DIR/transcripts/claude`: the transcript store. */
export function defaultStoreRoot(env: StoreEnv): string {
  return path.join(dataDirOf(env), "transcripts", "claude");
}

/** Where a resolved store root came from. */
export type StoreSource = "setting" | "data";

export interface ResolvedStore {
  root: string;
  source: StoreSource;
}

function realDirectory(p: string): string | undefined {
  try {
    const real = fs.realpathSync(p);
    return fs.statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The folder that the host's `~/.claude/projects` leads to (the end of the
 * link chain), or that folder itself when it is a real directory.
 * `undefined` when there is none or the link dangles. Agent Box doesn't use
 * it as the store; it only compares it with the store.
 */
export function hostProjectsRoot(env: StoreEnv): string | undefined {
  return realDirectory(path.join(env.home, ".claude", "projects"));
}

/**
 * Resolves the transcript store root: the `transcriptStore` setting when set
 * (an override), else `DATA_DIR/transcripts/claude`. The host's
 * `~/.claude/projects` doesn't influence the result.
 */
export function resolveStore(env: StoreEnv, explicit?: string): ResolvedStore {
  if (explicit !== undefined && explicit !== "") {
    return { root: path.resolve(explicit), source: "setting" };
  }
  return { root: defaultStoreRoot(env), source: "data" };
}

/** The transcript store root. See `resolveStore()`. */
export function claudeStoreRoot(env: StoreEnv, explicit?: string): string {
  return resolveStore(env, explicit).root;
}

/** Whether two paths lead to the same place, comparing real paths (links followed). */
export function sameLocation(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/** How an account's `projects` entry relates to the store. */
export type ProjectsLinkState =
  /** A link that leads to the store. */
  | "ok"
  /** No `projects` entry. */
  | "missing"
  /** A link whose target doesn't exist. */
  | "dangling"
  /** A link that leads to a place other than the store. */
  | "foreign"
  /** A real directory, which may hold transcripts of its own. */
  | "directory";

/** Classifies the `projects` entry of an account folder against the store. */
export function projectsLinkState(accountDir: string, storeRoot: string): ProjectsLinkState {
  const projects = path.join(accountDir, "projects");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(projects);
  } catch {
    return "missing";
  }
  if (!st.isSymbolicLink()) return st.isDirectory() ? "directory" : "foreign";
  try {
    fs.statSync(projects);
  } catch {
    return "dangling";
  }
  return sameLocation(projects, storeRoot) ? "ok" : "foreign";
}

/** The warning that `accounts check` shows for a `projects` entry, or `undefined` when it is fine. */
export function projectsLinkWarning(
  state: ProjectsLinkState,
  accountDir: string,
  storeRoot: string,
): string | undefined {
  const projects = path.join(accountDir, "projects");
  switch (state) {
    case "ok":
      return undefined;
    case "missing":
      return `${projects} doesn't exist, so this account can't see the transcripts in ${storeRoot}. Run "agentbox accounts relink".`;
    case "dangling":
      return `${projects} is a link to a folder that doesn't exist, so boxes on this account can't resume earlier conversations. Run "agentbox accounts relink".`;
    case "foreign":
      return `${projects} doesn't lead to the transcript store ${storeRoot}, so boxes on this account see other conversations. Run "agentbox accounts relink".`;
    case "directory":
      return `${projects} is a real folder, not a link to ${storeRoot}. Move its transcripts into the store by hand, then run "agentbox accounts relink".`;
  }
}

/** What `linkProjectsToStore()` did. */
export type LinkOutcome = "created" | "replaced" | "unchanged" | "kept-directory";

/**
 * Gives a Claude account folder a `projects` link to the store, creating the
 * store when needed. Makes the link when none exists, and replaces a link
 * that dangles or leads elsewhere (only the link; its target stays). Leaves a
 * real `projects` directory alone, since it can hold the only copy of
 * transcripts, unless it is empty.
 */
export function linkProjectsToStore(accountDir: string, storeRoot: string): LinkOutcome {
  const projects = path.join(accountDir, "projects");
  const state = projectsLinkState(accountDir, storeRoot);
  if (state === "ok") return "unchanged";
  if (state === "directory") {
    if (fs.readdirSync(projects).length > 0) return "kept-directory";
    fs.rmdirSync(projects);
  } else if (state === "dangling" || state === "foreign") {
    if (!fs.lstatSync(projects).isSymbolicLink()) return "kept-directory";
    fs.unlinkSync(projects);
  }
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  fs.symlinkSync(storeRoot, projects);
  return state === "missing" ? "created" : "replaced";
}

/** The number of entries in a store folder, or 0 when it doesn't exist. */
export function storeEntryCount(storeRoot: string): number {
  try {
    return fs.readdirSync(storeRoot).length;
  } catch {
    return 0;
  }
}
