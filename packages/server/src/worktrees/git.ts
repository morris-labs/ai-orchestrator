// Runs git on the host, never prompting and always in the C locale. A box
// can write the repositories this runs in, including `.git/config` and
// `.git/hooks`, so every call also turns off the settings that make git run
// a program: hooks, the fsmonitor, filter drivers, and transports other
// than local paths.
import { execFile } from "node:child_process";

export interface GitResult {
  ok: boolean;
  /** Standard output on success, standard error on failure. */
  output: string;
}

/**
 * Settings every host git call runs with. They are passed as command-line
 * configuration, which wins over any file a box can write.
 */
export const SAFE_GIT_CONFIG: readonly (readonly [string, string])[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  // Fetches here only read a local clone; ssh, ext::, and the rest would
  // run core.sshCommand, a remote helper, or a url.*.insteadOf target.
  ["protocol.allow", "never"],
  ["protocol.file.allow", "always"],
  // Runs through the shell when a repository has alternates.
  ["core.alternateRefsCommand", "true"],
  ["submodule.recurse", "false"],
];

/** The variables of a filter driver that name a program. */
const FILTER_COMMANDS = ["clean", "smudge", "process"];

function run(
  full: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ error: Error | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      full,
      { env, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
}

/** The environment that hands `pairs` to git as command-line configuration. */
export function configEnv(pairs: readonly (readonly [string, string])[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    GIT_CONFIG_COUNT: String(pairs.length),
  };
  pairs.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/**
 * Empty commands for every filter driver configured for `dir`: a driver's
 * name is arbitrary, so it can't be turned off without reading it first.
 * Reading configuration runs nothing.
 */
async function filterOverrides(dir: string, base: NodeJS.ProcessEnv): Promise<[string, string][]> {
  if (dir === "") return [];
  const r = await run(
    ["-C", dir, "config", "--name-only", "--get-regexp", "^filter\\."],
    base,
    30000,
  );
  if (r.error) return [];
  const drivers = new Set<string>();
  for (const key of r.stdout.split("\n")) {
    const dot = key.lastIndexOf(".");
    if (key.startsWith("filter.") && dot > "filter.".length) {
      drivers.add(key.slice("filter.".length, dot));
    }
  }
  const out: [string, string][] = [];
  for (const d of drivers) {
    for (const v of FILTER_COMMANDS) out.push([`filter.${d}.${v}`, ""]);
    out.push([`filter.${d}.required`, "false"]);
  }
  return out;
}

/**
 * Runs `git -C dir args...` with `SAFE_GIT_CONFIG` and every filter driver
 * turned off. Set `trim` to false for formats where leading spaces matter,
 * such as `status --porcelain -z`.
 */
export async function git(
  dir: string,
  args: readonly string[],
  options: { timeoutMs?: number; trim?: boolean } = {},
): Promise<GitResult> {
  const { timeoutMs = 30000, trim = true } = options;
  const full = dir === "" ? [...args] : ["-C", dir, ...args];
  const base = configEnv(SAFE_GIT_CONFIG);
  const env = configEnv([...SAFE_GIT_CONFIG, ...(await filterOverrides(dir, base))]);
  const { error, stdout, stderr } = await run(full, env, timeoutMs);
  if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
    return { ok: false, output: "could not run git" };
  }
  if (error && (error as { killed?: boolean }).killed) {
    return { ok: false, output: "git timed out" };
  }
  const ok = !error;
  const output = ok ? stdout : stderr;
  return { ok, output: trim ? output.trim() : output };
}
