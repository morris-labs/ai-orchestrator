// Builds the environment for every process the engine starts. A child gets
// only what its job needs: the credentials its profile takes come from the
// secrets broker (`credentials.ts`), and anything credential-like still in
// the engine's own environment, such as from a container that an older
// server started with secrets in it, is filtered by the same profile.
//
// A profile controls only what a child inherits through its environment. It
// isn't isolation. Every process in the container runs as the same user, so
// repository code that the `untrusted` profile starts (a test command, a
// reproduction script) can still, among others:
//
// - Ask the secrets broker's socket for any secret the project lists.
// - Read `/proc/PID/environ` of a vendor CLI or a `git` process, which hold
//   that child's credentials.
// - Read the engine token file that `AIO_ENGINE_TOKEN_FILE` names, and
//   the vendors' sign-in files under the home directory.
//
// With the engine token, such code can call the engine API, which can push.
// Only a separate user or a separate container would keep secrets from
// repository code; the engine has neither. What the engine does guarantee:
// its own `/proc/PID/environ` holds no credential (see
// `src/main/environ.ts`), and no child inherits a credential it doesn't need.
import type { Vendor } from "@aio/contracts";

/**
 * Who the child is:
 *
 * - `vendor:<name>`: a vendor CLI; keeps that vendor's credentials only.
 * - `github`: `gh` and the git commands that talk to a remote; keeps the
 *   GitHub token for pushes and API calls, and the SSH agent's socket.
 * - `untrusted`: the policy's test and lint commands, reproduction scripts,
 *   and anything else that runs code from the reviewed repository; inherits
 *   no credentials. It can still read them elsewhere as the same user (see
 *   the top of this file).
 */
export type EnvProfile = `vendor:${Vendor}` | "github" | "untrusted";

/** Variables the engine owns. No child ever sees them. */
const ENGINE_PREFIX = /^AIO_/;

/** Names that look like a credential of any kind. */
const SECRET_NAME =
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH|COOKIE|SESSION_?KEY)(_|$)/i;

/** Credentials the GitHub tools need. */
const GITHUB_CREDENTIALS = [
  /^GH_TOKEN$/,
  /^GITHUB_TOKEN$/,
  /^GH_ENTERPRISE_TOKEN$/,
  /^GITHUB_ENTERPRISE_TOKEN$/,
];

/** Credentials each vendor CLI needs to sign in. */
const VENDOR_CREDENTIALS: Record<Vendor, RegExp[]> = {
  claude: [/^ANTHROPIC_/, /^CLAUDE_CODE_/, /^AWS_/, /^GOOGLE_APPLICATION_CREDENTIALS$/],
  codex: [/^OPENAI_/, /^CODEX_/, /^AZURE_OPENAI_/],
  copilot: [/^COPILOT_/, ...GITHUB_CREDENTIALS],
};

/** Prefixes of vendor settings, withheld from every child but that vendor's CLI. */
const VENDOR_SETTINGS = [
  /^ANTHROPIC_/,
  /^CLAUDE_CODE_/,
  /^OPENAI_/,
  /^CODEX_/,
  /^AZURE_OPENAI_/,
  /^COPILOT_/,
];

function kept(profile: EnvProfile): RegExp[] {
  if (profile === "github") return GITHUB_CREDENTIALS;
  if (profile === "untrusted") return [];
  return VENDOR_CREDENTIALS[profile.slice("vendor:".length) as Vendor] ?? [];
}

/**
 * True when `name` looks like a credential: a secret-like name, or a
 * variable some vendor or GitHub tool takes its credentials from. The engine
 * keeps these out of its own `/proc/PID/environ`.
 */
export function looksLikeCredential(name: string): boolean {
  if (SECRET_NAME.test(name)) return true;
  if (GITHUB_CREDENTIALS.some((re) => re.test(name))) return true;
  return Object.values(VENDOR_CREDENTIALS).some((list) => list.some((re) => re.test(name)));
}

/**
 * True when the profile's child takes `name` as a credential, so the engine
 * asks the secrets broker for it: a vendor CLI's sign-in variables, or the
 * GitHub tokens for `git` and `gh`. Always false for `untrusted`.
 */
export function wantsCredential(name: string, profile: EnvProfile): boolean {
  if (ENGINE_PREFIX.test(name)) return false;
  return kept(profile).some((re) => re.test(name));
}

/** True when `name` is a variable the profile must not pass on. */
export function isWithheld(name: string, profile: EnvProfile): boolean {
  if (ENGINE_PREFIX.test(name)) return true;
  if (kept(profile).some((re) => re.test(name))) return false;
  // The SSH agent's socket isn't a secret, but it lets a process sign in
  // with the agent's keys, so only `git` and `gh` get it, for an SSH remote.
  if (profile === "github" && name === "SSH_AUTH_SOCK") return false;
  if (SECRET_NAME.test(name)) return true;
  // Vendor settings that aren't secret, such as `ANTHROPIC_BASE_URL`, still
  // aren't another child's business.
  return VENDOR_SETTINGS.some((re) => re.test(name));
}

/**
 * The environment for a child: `base` (this process's environment by
 * default) without the variables the profile withholds, plus `extra`. An
 * `undefined` value in `extra` removes the variable. `extra` is the caller's
 * explicit choice, so it is never filtered.
 */
export function childEnv(
  profile: EnvProfile,
  extra: Record<string, string | undefined> = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && !isWithheld(name, profile)) env[name] = value;
  }
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  if (profile === "vendor:copilot") dropClassicCopilotTokens(env);
  return env;
}

/**
 * The variables the Copilot CLI reads a token from, in its order of
 * precedence. The CLI takes the first one set over its own sign-in.
 */
export const COPILOT_TOKEN_VARIABLES = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
] as const;

/**
 * True for a classic personal access token (`ghp_`). The Copilot CLI refuses
 * one; it takes a fine-grained token (`github_pat_`), an OAuth token
 * (`gho_`), or a GitHub App user token (`ghu_`).
 */
export function isClassicGitHubToken(value: string | undefined): boolean {
  return value !== undefined && value.trim().startsWith("ghp_");
}

/**
 * Removes every classic token from a Copilot environment, so that the CLI
 * falls through to a usable token or to its own sign-in instead of failing.
 * Returns the names it removed.
 */
export function dropClassicCopilotTokens(env: NodeJS.ProcessEnv): string[] {
  const dropped: string[] = [];
  for (const name of COPILOT_TOKEN_VARIABLES) {
    if (isClassicGitHubToken(env[name])) {
      delete env[name];
      dropped.push(name);
    }
  }
  return dropped;
}

/**
 * Explains why Copilot might not sign in, or returns `null` when the
 * environment holds a token Copilot accepts or no classic token at all. The
 * environment is the one the engine would hand a Copilot child, before the
 * classic tokens are dropped. The message names variables, never values.
 */
export function copilotTokenProblem(
  base: NodeJS.ProcessEnv = process.env,
  extra: Record<string, string | undefined> = {},
): string | null {
  const merged: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete merged[name];
    else merged[name] = value;
  }
  const classic = COPILOT_TOKEN_VARIABLES.filter((n) => isClassicGitHubToken(merged[n]));
  if (classic.length === 0) return null;
  const usable = COPILOT_TOKEN_VARIABLES.some(
    (n) => merged[n] !== undefined && merged[n] !== "" && !isClassicGitHubToken(merged[n]),
  );
  if (usable) return null;
  return (
    `${classic.join(" and ")} ${classic.length === 1 ? "holds" : "hold"} a classic personal access token (ghp_), ` +
    "which the Copilot CLI refuses, so the engine doesn't pass it to Copilot. " +
    "Sign in to Copilot inside the container with `copilot` and `/login`, or set " +
    "COPILOT_GITHUB_TOKEN to a fine-grained token with the Copilot Requests permission."
  );
}

/** The git subcommands that talk to a remote and so need the GitHub token. */
const NETWORK_GIT_COMMANDS = new Set(["push", "fetch", "pull", "ls-remote", "clone"]);

/** The git options before the subcommand that take their value as the next argument. */
const GIT_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
]);

/** The subcommand of a git command line, or `null` when it has none. */
export function gitSubcommand(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (GIT_OPTIONS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

/**
 * The profile for a program run without a shell. `gh` and the git commands
 * that talk to a remote (`push`, `fetch`, `pull`, `ls-remote`, `clone`) get
 * GitHub access. Every other git command, such as `status`, `show`, or
 * `worktree add`, gets none: it doesn't need the token, and it can run code
 * from the repository through hooks and filters.
 */
export function profileForProgram(program: string, args: readonly string[] = []): EnvProfile {
  const name = program.split("/").pop() ?? program;
  if (name === "gh") return "github";
  if (name !== "git") return "untrusted";
  const sub = gitSubcommand(args);
  return sub !== null && NETWORK_GIT_COMMANDS.has(sub) ? "github" : "untrusted";
}
