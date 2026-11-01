// The shared Claude transcript store (option S of `docs/v4/design-accounts.md`,
// owner decision 1): every Claude account's `projects` entry is a symbolic
// link to one store, so resume, fork, the conversation picker, Purge, and
// Move work whichever account a box uses.
//
// The store is the host's own transcript store when the host has one. A
// store that the data directory invents while the host has transcripts hides
// every earlier conversation from the boxes, so the data directory's store is
// the last choice.
import fs from "node:fs";
import path from "node:path";
import { accountDirFor, dataDirOf, type HostEnv } from "../records/env.js";

type StoreEnv = Pick<HostEnv, "home" | "dataDir">;

/** `DATA_DIR/transcripts/claude`: the store for a host that has none. */
export function defaultStoreRoot(env: StoreEnv): string {
  return path.join(dataDirOf(env), "transcripts", "claude");
}

/** Where a resolved store root came from. */
export type StoreSource = "setting" | "host" | "account" | "data";

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
 * The host's own transcript store: the folder that `~/.claude/projects` leads
 * to (a link's target), or that folder itself when it is a real directory.
 * `undefined` when the host has none, or the link dangles.
 */
export function hostStoreRoot(env: StoreEnv): string | undefined {
  return realDirectory(path.join(env.home, ".claude", "projects"));
}

/** The folder that an account's `projects` entry leads to, when it resolves. */
function accountStoreRoot(env: StoreEnv, defaultAccount: string | undefined): string | undefined {
  const name = defaultAccount?.startsWith("claude/") ? defaultAccount.slice("claude/".length) : "";
  if (name === "") return undefined;
  return realDirectory(path.join(accountDirFor(env, "claude", name), "projects"));
}

/**
 * Resolves the transcript store root, in this order:
 *
 * 1. `explicit`, the `transcriptStore` setting.
 * 2. The host's store: the target of `~/.claude/projects`, or that folder
 *    itself when it is a real directory.
 * 3. Where the default Claude account's `projects` entry leads, when it
 *    resolves. A host without a store can still have an account that has one.
 * 4. `DATA_DIR/transcripts/claude`, only when the host has none.
 *
 * An account's own `projects` link never outranks the host's store, because a
 * link that dangles or leads to a scratch store is what this order guards
 * against.
 */
export function resolveStore(
  env: StoreEnv,
  defaultAccount: string | undefined,
  explicit?: string,
): ResolvedStore {
  if (explicit !== undefined && explicit !== "") {
    return { root: path.resolve(explicit), source: "setting" };
  }
  const host = hostStoreRoot(env);
  if (host !== undefined) return { root: host, source: "host" };
  const account = accountStoreRoot(env, defaultAccount);
  if (account !== undefined) return { root: account, source: "account" };
  return { root: defaultStoreRoot(env), source: "data" };
}

/** The transcript store root. See `resolveStore()`. */
export function claudeStoreRoot(
  env: StoreEnv,
  defaultAccount: string | undefined,
  explicit?: string,
): string {
  return resolveStore(env, defaultAccount, explicit).root;
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

function sameLocation(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

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
