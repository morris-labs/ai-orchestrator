// The shared Claude transcript store (option S of `docs/v4/design-accounts.md`,
// owner decision 1): every Claude account's `projects` entry is a symbolic
// link to one store, so resume, fork, the conversation picker, Purge, and
// Move work whichever account a box uses.
import fs from "node:fs";
import path from "node:path";
import { accountDirFor, dataDirOf, type HostEnv } from "../records/env.js";

/** `DATA_DIR/transcripts/claude`: the store for a host that has none yet. */
export function defaultStoreRoot(env: Pick<HostEnv, "home" | "dataDir">): string {
  return path.join(dataDirOf(env), "transcripts", "claude");
}

/**
 * The transcript store root: where the default Claude account's `projects`
 * entry leads (a link's target, or the directory itself for an account made
 * by hand), else `defaultStoreRoot()`.
 */
export function claudeStoreRoot(
  env: Pick<HostEnv, "home" | "dataDir">,
  defaultAccount: string | undefined,
): string {
  const name = defaultAccount?.startsWith("claude/") ? defaultAccount.slice("claude/".length) : "";
  if (name !== "") {
    const projects = path.join(accountDirFor(env, "claude", name), "projects");
    try {
      const st = fs.lstatSync(projects);
      if (st.isSymbolicLink())
        return path.resolve(path.dirname(projects), fs.readlinkSync(projects));
      if (st.isDirectory()) return projects;
    } catch {
      // No projects entry yet: fall through to the default store.
    }
  }
  return defaultStoreRoot(env);
}

/**
 * Gives a Claude account folder a `projects` link to the store, creating the
 * store when needed. Leaves an existing `projects` entry alone. Returns
 * whether it made the link.
 */
export function linkProjectsToStore(accountDir: string, storeRoot: string): boolean {
  const projects = path.join(accountDir, "projects");
  try {
    fs.lstatSync(projects);
    return false;
  } catch {
    // Absent: make the link.
  }
  fs.mkdirSync(storeRoot, { recursive: true, mode: 0o700 });
  fs.symlinkSync(storeRoot, projects);
  return true;
}
