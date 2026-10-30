// The command line for a second instance of an Electron app that a
// Playwright smoke test launched, for the apps' single-instance checks.
//
// The test spawns the second instance itself, because Playwright's launch
// fails on a process that exits before its debugger connects. It must start
// that process the way Playwright started the first one. On Linux,
// Playwright adds `--no-sandbox`. Without it, Chromium needs the setuid
// `chrome-sandbox` helper on a host that restricts unprivileged user
// namespaces, such as Ubuntu 23.10 and later, and the copy in
// `node_modules` isn't setuid. Chromium then aborts with SIGTRAP before the
// app's code runs, so `spawnSync` reports status `null`. Playwright also
// removes `NODE_OPTIONS`, which the test runner can set for its own loader.

export interface SecondInstanceCommand {
  args: string[];
  env: Record<string, string>;
}

/**
 * Returns the arguments and environment for a second instance: `args` with
 * `--no-sandbox` first on Linux, as Playwright's `_electron.launch` adds it,
 * and `env` without `NODE_OPTIONS`.
 */
export function secondInstanceCommand(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): SecondInstanceCommand {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key !== "NODE_OPTIONS") clean[key] = value;
  }
  const sandbox = platform === "linux" && !args.includes("--no-sandbox") ? ["--no-sandbox"] : [];
  return { args: [...sandbox, ...args], env: clean };
}

/** Describes how a spawned process ended, for an assertion's message. */
export function describeExit(result: {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stderr?: Buffer | string | null;
}): string {
  const how =
    result.error !== undefined
      ? `failed to run: ${result.error.message}`
      : result.status === null
        ? `was killed by ${result.signal ?? "a signal"}`
        : `exited with status ${result.status}`;
  const stderr = result.stderr?.toString().trim();
  return stderr
    ? `The second instance ${how}. Its stderr:\n${stderr}`
    : `The second instance ${how}.`;
}
