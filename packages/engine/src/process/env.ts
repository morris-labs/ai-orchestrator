// Builds the environment for every process the engine starts. The engine's
// own environment holds its bearer token and, often, credentials for every
// vendor and for GitHub; a child gets only what its job needs.
import type { Vendor } from "@agentbox/contracts";

/**
 * Who the child is:
 *
 * - `vendor:<name>`: a vendor CLI; keeps that vendor's credentials only.
 * - `github`: `git` and `gh`; keeps the GitHub token for pushes and API calls.
 * - `untrusted`: the policy's test and lint commands, reproduction scripts,
 *   and anything else that runs code from the reviewed repository; keeps no
 *   credentials at all.
 */
export type EnvProfile = `vendor:${Vendor}` | "github" | "untrusted";

/** Variables the engine owns. No child ever sees them. */
const ENGINE_PREFIX = /^AGENTBOX_/;

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

/** True when `name` is a variable the profile must not pass on. */
export function isWithheld(name: string, profile: EnvProfile): boolean {
  if (ENGINE_PREFIX.test(name)) return true;
  if (kept(profile).some((re) => re.test(name))) return false;
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
  return env;
}

/** The profile for a program run without a shell: `git` and `gh` get GitHub access. */
export function profileForProgram(program: string): EnvProfile {
  const name = program.split("/").pop() ?? program;
  return name === "git" || name === "gh" ? "github" : "untrusted";
}
