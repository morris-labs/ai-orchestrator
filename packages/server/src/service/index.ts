// `aio-server install-service` on each host: a systemd user unit on Linux, a
// launchd LaunchAgent on macOS, and a Task Scheduler logon task on Windows.
import path from "node:path";
import type { ProcessRunner } from "../jobs/process.js";
import {
  defaultDataDir,
  pathFor,
  serviceManagerOf,
  type HostPlatform,
  type ServiceManagerKind,
} from "../platform/host.js";
import { installService, serviceInstalled, unitPath } from "../systemd/service.js";
import {
  installLaunchAgent,
  launchAgentInstalled,
  launchAgentLogPath,
  launchAgentPath,
} from "./launchd.js";
import { installScheduledTask, scheduledTaskInstalled, TASK_NAME, taskUser } from "./schtasks.js";

export { LAUNCHD_LABEL, launchAgentPath, launchAgentPlist, launchctlCommands } from "./launchd.js";
export { TASK_NAME, schtasksCommands, taskXml, windowsQuote } from "./schtasks.js";

/** Quotes one `ExecStart=` word for systemd when it needs it. */
export function systemdWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `"${word.replace(/(["\\])/g, "\\$1")}"`;
}

/** The `ExecStart=` line for an argv. */
export function systemdExecStart(argv: readonly string[]): string {
  return argv.map(systemdWord).join(" ");
}

/**
 * The windowless copy of `node.exe` that the Windows package ships beside
 * it: the same program with its PE subsystem set to Windows GUI, so a
 * logon task that runs it opens no console window. See
 * `scripts/stage-runtime.mjs`.
 */
export const WINDOWLESS_NODE = "aio-serverw.exe";

/** The program the Windows task runs: the windowless Node.js when it exists beside `node`, else `node`. */
export function windowsTaskProgram(p: HostPlatform, node: string): string {
  const windowless = path.win32.join(path.win32.dirname(node), WINDOWLESS_NODE);
  return p.exists(windowless) ? windowless : node;
}

/** The log file of a Windows task, which has no console to write to. */
export function windowsLogFile(dataDir: string): string {
  return path.win32.join(dataDir, "server.log");
}

export interface ServerServiceOptions {
  platform: HostPlatform;
  /** The argv that starts the server: Node.js, `main.js`, and any `--data-dir`. */
  command: readonly string[];
  /** The data directory, or `undefined` for the default. The Windows task keeps its files here. */
  dataDir?: string;
  runner: ProcessRunner;
  log?: (s: string) => void;
}

/** Writes the service definition for the host, then enables and starts it. */
export async function installServerService(opts: ServerServiceOptions): Promise<{ path: string }> {
  const p = opts.platform;
  const [program, ...args] = opts.command as [string, ...string[]];
  switch (serviceManagerOf(p)) {
    case "systemd":
      return installService({
        home: p.home,
        execStart: systemdExecStart(opts.command),
        runner: opts.runner,
        log: opts.log,
      });
    case "launchd":
      if (p.uid === undefined) throw new Error("launchctl needs the user's numeric id.");
      return installLaunchAgent({
        home: p.home,
        uid: p.uid,
        programArguments: opts.command,
        pathDirs: [path.posix.dirname(program)],
        runner: opts.runner,
        log: opts.log,
      });
    case "schtasks": {
      const dataDir = opts.dataDir ?? defaultDataDir(p);
      return installScheduledTask({
        // The host's own path functions: this is a file the server writes.
        xmlFile: path.join(dataDir, `${TASK_NAME}-task.xml`),
        command: windowsTaskProgram(p, program),
        args: [...args, "--log-file", windowsLogFile(dataDir)],
        workingDirectory: p.home,
        user: taskUser(p.env),
        runner: opts.runner,
        log: opts.log,
      });
    }
  }
}

/** True when the host's service definition exists. */
export async function serverServiceInstalled(
  p: HostPlatform,
  runner: ProcessRunner,
): Promise<boolean> {
  switch (serviceManagerOf(p)) {
    case "systemd":
      return serviceInstalled(p.home);
    case "launchd":
      return launchAgentInstalled(p.home);
    case "schtasks":
      return scheduledTaskInstalled(runner);
  }
}

/** What `install-service` writes on the host, for help text and messages. */
export function serviceSummary(p: HostPlatform): {
  kind: ServiceManagerKind;
  where: string;
  logs: string;
} {
  switch (serviceManagerOf(p)) {
    case "systemd":
      return {
        kind: "systemd",
        where: unitPath(p.home).replace(p.home, "~"),
        logs: "journalctl --user -u aio-server",
      };
    case "launchd":
      return {
        kind: "launchd",
        where: launchAgentPath(p.home).replace(p.home, "~"),
        logs: launchAgentLogPath(p.home).replace(p.home, "~"),
      };
    case "schtasks":
      return {
        kind: "schtasks",
        where: `the Task Scheduler task ${TASK_NAME}`,
        logs: pathFor(p).join(defaultDataDir({ ...p, home: "~" }), "server.log"),
      };
  }
}
