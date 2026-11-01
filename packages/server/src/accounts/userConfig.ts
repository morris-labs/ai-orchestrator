// Shared user configuration (owner decision 7 of docs/v4/design-accounts.md).
//
// The user-level entries of `~/.claude` describe the person, not the
// subscription: the global `CLAUDE.md`, `settings.json`, skills, agents, and
// so on. Each Claude account links those entries to the host's copies, so an
// edit on the host reaches every account and the accounts can't drift apart.
//
// Never linked: everything that is sign-in or per-account state, namely
// `.credentials.json`, `.claude.json`, `policy-limits.json`,
// `remote-settings.json` (and their signature files), `sessions/`,
// `projects/` (linked to the transcript store instead), `todos/`, `statsig/`,
// `history.jsonl`, `shell-snapshots/`, `file-history/`, `session-env/`,
// `backups/`, `cache/`, and `agent-memory/`. The list below is an allowlist,
// so an entry that Claude Code adds later stays per-account until it is added
// here.
//
// An account opts out of an entry by replacing the link with a real file or
// folder. Linking and `accounts check` leave such an entry alone, except that
// a copy identical to the host's is replaced by the link, because nothing is
// lost by that. Containers see the link targets through the same mounts as
// the `projects` link (`linkTargetsOutside()`), and only those entries, never
// the whole `~/.claude`, which holds the host's sign-in.
import fs from "node:fs";
import path from "node:path";

/** Entries of `~/.claude` that are linked when they exist (Claude Code 2.1.316). */
export const SHARED_ENTRIES = [
  "CLAUDE.md",
  "settings.json",
  "skills",
  "agents",
  "commands",
  "plugins",
  "hooks",
  "output-styles",
  "rules",
  "keybindings.json",
  "loop.md",
] as const;

/** Statusline scripts, such as `statusline.sh` or `statusline-command.sh`. */
const STATUSLINE = /^statusline[^/]*$/;

/** Names that are never linked, whatever the allowlist says. */
const NEVER = new Set([
  ".credentials.json",
  ".claude.json",
  "policy-limits.json",
  "remote-settings.json",
  "sessions",
  "projects",
  "todos",
  "statsig",
  "history.jsonl",
  "shell-snapshots",
]);

/** What happened to one entry. */
export type EntryOutcome =
  /** Already a link to the host's entry. */
  | "unchanged"
  /** Was missing, or a link that dangled; now a link. */
  | "linked"
  /** Was a copy identical to the host's; now a link. */
  | "replaced-identical"
  /** A real file or folder, or a link elsewhere, that differs; left alone. */
  | "local";

export interface UserConfigResult {
  /** The outcome for each entry the host has, by name. */
  entries: Record<string, EntryOutcome>;
  /** Entries that failed to link, by name, with the reason. */
  errors: Record<string, string>;
}

/** The names of the host entries that are shared, in a stable order. */
export function sharedNames(hostDir: string): string[] {
  const names = new Set<string>();
  for (const n of SHARED_ENTRIES) names.add(n);
  try {
    for (const n of fs.readdirSync(hostDir)) if (STATUSLINE.test(n)) names.add(n);
  } catch {
    // No host folder: nothing to share.
  }
  return [...names].filter((n) => !NEVER.has(n)).sort();
}

function lstat(p: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(p);
  } catch {
    return undefined;
  }
}

function realOf(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

/** Whether two files or folders have the same names and bytes. */
function sameContent(a: string, b: string): boolean {
  const sa = lstat(a);
  const sb = lstat(b);
  if (!sa || !sb) return false;
  if (sa.isSymbolicLink() || sb.isSymbolicLink()) {
    return sa.isSymbolicLink() && sb.isSymbolicLink() && fs.readlinkSync(a) === fs.readlinkSync(b);
  }
  if (sa.isDirectory() && sb.isDirectory()) {
    const na = fs.readdirSync(a).sort();
    const nb = fs.readdirSync(b).sort();
    return (
      na.length === nb.length &&
      na.every((n, i) => n === nb[i] && sameContent(path.join(a, n), path.join(b, n)))
    );
  }
  if (sa.isFile() && sb.isFile()) {
    return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
  }
  return false;
}

/** What the account's entry is, compared with the host's. */
function classify(
  account: string,
  host: string,
): "missing" | "linked" | "dangling" | "elsewhere" | "identical" | "local" {
  const st = lstat(account);
  if (!st) return "missing";
  if (st.isSymbolicLink()) {
    const real = realOf(account);
    if (real === undefined) return "dangling";
    return real === realOf(host) ? "linked" : "elsewhere";
  }
  return sameContent(account, host) ? "identical" : "local";
}

/** Replaces `account` by a link, removing a copy or a dangling link first. */
function makeLink(account: string, host: string): void {
  const st = lstat(account);
  if (st) fs.rmSync(account, { recursive: true, force: true });
  fs.symlinkSync(host, account);
}

/**
 * Links the shared user-config entries of `hostDir` into `accountDir`. Safe
 * to repeat. Never changes a real file or folder that differs from the
 * host's, and never touches the host's files.
 */
export function linkUserConfig(accountDir: string, hostDir: string): UserConfigResult {
  const result: UserConfigResult = { entries: {}, errors: {} };
  // The account folder is the host folder (or inside it): nothing to link.
  const realAccount = realOf(accountDir);
  const realHost = realOf(hostDir);
  if (realAccount === undefined || realHost === undefined || realAccount === realHost) {
    return result;
  }
  for (const name of sharedNames(hostDir)) {
    const host = path.join(hostDir, name);
    if (!lstat(host)) continue;
    const account = path.join(accountDir, name);
    try {
      const state = classify(account, host);
      switch (state) {
        case "linked":
          result.entries[name] = "unchanged";
          break;
        case "missing":
        case "dangling":
          makeLink(account, host);
          result.entries[name] = "linked";
          break;
        case "identical":
          makeLink(account, host);
          result.entries[name] = "replaced-identical";
          break;
        default:
          result.entries[name] = "local";
      }
    } catch (err) {
      result.errors[name] = (err as Error).message;
    }
  }
  return result;
}

/**
 * The warnings that `accounts check` shows for the shared entries: a host
 * entry the account neither links nor overrides, a local override (reported
 * so it is a choice, not a surprise), and a linked `settings.json` that lacks
 * the bypass acceptance.
 */
export function userConfigWarnings(accountDir: string, hostDir: string): string[] {
  const out: string[] = [];
  const realAccount = realOf(accountDir);
  const realHost = realOf(hostDir);
  if (realAccount === undefined || realHost === undefined || realAccount === realHost) return out;
  for (const name of sharedNames(hostDir)) {
    const host = path.join(hostDir, name);
    if (!lstat(host)) continue;
    const account = path.join(accountDir, name);
    const st = lstat(account);
    if (!st) {
      out.push(
        `${name} isn't linked to ${host}, so this account lacks your global ${name}. Run "agentbox accounts relink".`,
      );
    } else if (st.isSymbolicLink() && realOf(account) === undefined) {
      out.push(`${account} is a link that dangles. Run "agentbox accounts relink".`);
    } else if (!st.isSymbolicLink() || realOf(account) !== realOf(host)) {
      out.push(
        `${name} is a local override: this account doesn't use ${host}. To use the host's, move ${account} away and run "agentbox accounts relink".`,
      );
    }
  }
  return out;
}
