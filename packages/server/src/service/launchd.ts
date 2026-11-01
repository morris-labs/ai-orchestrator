// The launchd LaunchAgent that runs `aio-server` on macOS.
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../api/errors.js";
import type { ProcessRunner } from "../jobs/process.js";

/** The job label, which also names the plist file. */
export const LAUNCHD_LABEL = "dev.aio.server";

/** The LaunchAgent plist under a home directory. */
export function launchAgentPath(home: string): string {
  return path.posix.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/** The log file that the agent's standard output and error go to. */
export function launchAgentLogPath(home: string): string {
  return path.posix.join(home, "Library", "Logs", "aio-server.log");
}

/**
 * The `PATH` the agent runs with. launchd starts agents with only
 * `/usr/bin:/bin:/usr/sbin:/sbin`, which misses the tools the server runs:
 * `docker` (Docker Desktop links it into `/usr/local/bin`, and keeps it in
 * its app bundle), `op` and `git` from Homebrew (`/opt/homebrew/bin` on
 * Apple silicon, `/usr/local/bin` on Intel), and `ssh` in `/usr/bin`.
 * `extraDirs`, such as the directory of the bundled Node.js, go first.
 */
export function launchAgentPathVar(extraDirs: readonly string[] = []): string {
  return [
    ...extraDirs,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .filter((d, i, all) => all.indexOf(d) === i)
    .join(":");
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The content of the LaunchAgent plist.
 *
 * - `RunAtLoad` starts the server at login and when it's bootstrapped.
 * - `KeepAlive` with `SuccessfulExit` false restarts the server when it
 *   exits with an error, like systemd's `Restart=on-failure`, but not
 *   after a clean stop. `ThrottleInterval` waits 5 seconds between
 *   starts, like `RestartSec=5`; launchd never gives up, like
 *   `StartLimitIntervalSec=0`.
 * - `Umask` 63 (octal 077) keeps files the server creates without an
 *   explicit mode private to the user, like `UMask=0077`.
 * - `ProcessType` `Interactive` stops macOS from throttling the server
 *   like a background job; the apps and the CLI wait on its answers.
 */
export function launchAgentPlist(opts: {
  programArguments: readonly string[];
  home: string;
  pathDirs?: readonly string[];
}): string {
  const log = launchAgentLogPath(opts.home);
  const string = (s: string) => `\t\t<string>${xml(s)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${LAUNCHD_LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    ...opts.programArguments.map(string),
    "\t</array>",
    "\t<key>EnvironmentVariables</key>",
    "\t<dict>",
    "\t\t<key>NODE_ENV</key>",
    "\t\t<string>production</string>",
    "\t\t<key>PATH</key>",
    `\t\t<string>${xml(launchAgentPathVar(opts.pathDirs))}</string>`,
    "\t</dict>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<dict>",
    "\t\t<key>SuccessfulExit</key>",
    "\t\t<false/>",
    "\t</dict>",
    "\t<key>ThrottleInterval</key>",
    "\t<integer>5</integer>",
    "\t<key>Umask</key>",
    "\t<integer>63</integer>",
    "\t<key>ProcessType</key>",
    "\t<string>Interactive</string>",
    "\t<key>StandardOutPath</key>",
    `\t<string>${xml(log)}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${xml(log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/**
 * The `launchctl` commands that load the agent into the user's GUI domain
 * and start it. `bootout` comes first, so that a reinstall loads the new
 * plist; it fails when the agent isn't loaded, which is fine. `enable`
 * clears a disabled state that `launchctl disable` left behind, and
 * `bootstrap` loads the plist, which starts the server through
 * `RunAtLoad`.
 */
export function launchctlCommands(
  uid: number,
  plist: string,
): { args: string[]; mayFail: boolean }[] {
  const domain = `gui/${uid}`;
  return [
    { args: ["bootout", `${domain}/${LAUNCHD_LABEL}`], mayFail: true },
    { args: ["enable", `${domain}/${LAUNCHD_LABEL}`], mayFail: false },
    { args: ["bootstrap", domain, plist], mayFail: false },
  ];
}

/**
 * Writes the LaunchAgent plist, then loads and starts it with
 * `launchctl`. Throws `conflict` with launchctl's output when a step that
 * must succeed fails.
 */
export async function installLaunchAgent(opts: {
  home: string;
  uid: number;
  programArguments: readonly string[];
  pathDirs?: readonly string[];
  runner: ProcessRunner;
  log?: (s: string) => void;
}): Promise<{ path: string }> {
  const plist = launchAgentPath(opts.home);
  await mkdir(path.posix.dirname(plist), { recursive: true });
  await mkdir(path.posix.dirname(launchAgentLogPath(opts.home)), { recursive: true });
  await writeFile(plist, launchAgentPlist(opts), { mode: 0o644 });
  opts.log?.(`Wrote ${plist}.\r\n`);
  for (const { args, mayFail } of launchctlCommands(opts.uid, plist)) {
    opts.log?.(`Running: launchctl ${args.join(" ")}\r\n`);
    const result = await opts.runner.run("launchctl", args, { timeoutMs: 30_000 });
    if (result.code !== 0 && !mayFail) {
      const output = (result.stderr || result.stdout).trim();
      throw new ApiError(
        "conflict",
        `launchctl ${args.join(" ")} failed${output ? `: ${output}` : "."}`,
      );
    }
  }
  return { path: plist };
}

/** True when the LaunchAgent plist exists. */
export async function launchAgentInstalled(home: string): Promise<boolean> {
  try {
    await access(launchAgentPath(home));
    return true;
  } catch {
    return false;
  }
}
