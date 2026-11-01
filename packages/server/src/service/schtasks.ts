// The Task Scheduler task that runs `aio-server` on Windows.
//
// Why a logon task and not a Windows service: a service runs in session 0
// as LocalSystem or as an account whose password Windows must store, while
// the server needs the user's own profile (`~/.claude`, `~/.ssh`, the data
// directory), the user's access to the Docker Desktop pipe (the
// `docker-users` group), and the user's 1Password CLI sign-in. A task that
// runs at the user's logon with the user's interactive token has all of
// these, and a standard user can create one for themself without
// administrator rights. A Startup folder shortcut or a `Run` registry value
// also needs no rights, but neither restarts a server that exits.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../api/errors.js";
import type { ProcessRunner } from "../jobs/process.js";

/** The task name in the Task Scheduler library root. */
export const TASK_NAME = "aio-server";

function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Quotes one argument the way `CommandLineToArgvW` and the C runtime read
 * it back: arguments with a space, a tab, or a quote get double quotes;
 * backslashes double only in front of a quote.
 */
export function windowsQuote(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      slashes++;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(slashes * 2 + 1) + '"';
    } else {
      out += "\\".repeat(slashes) + ch;
    }
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/** The account the task runs as, `DOMAIN\user`, from the environment, or `undefined`. */
export function taskUser(env: NodeJS.ProcessEnv): string | undefined {
  if (!env.USERNAME) return undefined;
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
}

/**
 * The task definition, in Task Scheduler's XML schema.
 *
 * - The logon trigger starts the server when the user logs on. It repeats
 *   every 5 minutes, and `IgnoreNew` drops a start while the server runs,
 *   so a server that exited comes back within 5 minutes. Task Scheduler's
 *   own `RestartOnFailure` covers only a task that fails to start, not a
 *   program that exits with an error.
 * - `ExecutionTimeLimit` `PT0S` turns off the default 72-hour limit,
 *   after which Task Scheduler would stop the server.
 * - The battery settings keep the server running on a laptop that
 *   unplugs.
 * - `InteractiveToken` and `LeastPrivilege` run it as the logged-on user
 *   without elevation.
 */
export function taskXml(opts: {
  command: string;
  args: readonly string[];
  workingDirectory: string;
  user?: string;
  description?: string;
}): string {
  const user = opts.user ? `<UserId>${xml(opts.user)}</UserId>` : "";
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>${xml(opts.description ?? "AI Orchestrator server")}</Description>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    ...(user ? [`      ${user}`] : []),
    "      <Repetition>",
    "        <Interval>PT5M</Interval>",
    "        <StopAtDurationEnd>false</StopAtDurationEnd>",
    "      </Repetition>",
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    ...(user ? [`      ${user}`] : []),
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${xml(opts.command)}</Command>`,
    `      <Arguments>${xml(opts.args.map(windowsQuote).join(" "))}</Arguments>`,
    `      <WorkingDirectory>${xml(opts.workingDirectory)}</WorkingDirectory>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/**
 * The task XML as `schtasks /XML` reads it most reliably: UTF-16
 * little-endian with a byte order mark, matching the declaration.
 */
export function taskXmlBytes(text: string): Buffer {
  return Buffer.from(`\ufeff${text}`, "utf16le");
}

/** The `schtasks` commands that register the task, replacing an older one, and start it. */
export function schtasksCommands(xmlFile: string): string[][] {
  return [
    ["/Create", "/TN", TASK_NAME, "/XML", xmlFile, "/F"],
    ["/Run", "/TN", TASK_NAME],
  ];
}

/**
 * Writes the task definition to `xmlFile`, registers it with `schtasks`,
 * and starts it. The file stays, so you can read what was registered.
 * Throws `conflict` with schtasks' output when a step fails.
 */
export async function installScheduledTask(opts: {
  xmlFile: string;
  command: string;
  args: readonly string[];
  workingDirectory: string;
  user?: string;
  runner: ProcessRunner;
  log?: (s: string) => void;
}): Promise<{ path: string }> {
  await mkdir(path.dirname(opts.xmlFile), { recursive: true });
  await writeFile(opts.xmlFile, taskXmlBytes(taskXml(opts)));
  opts.log?.(`Wrote ${opts.xmlFile}.\r\n`);
  for (const args of schtasksCommands(opts.xmlFile)) {
    opts.log?.(`Running: schtasks ${args.join(" ")}\r\n`);
    const result = await opts.runner.run("schtasks", args, { timeoutMs: 30_000 });
    if (result.code !== 0) {
      const output = (result.stderr || result.stdout).trim();
      throw new ApiError(
        "conflict",
        `schtasks ${args.join(" ")} failed${output ? `: ${output}` : "."}`,
      );
    }
  }
  return { path: `Task Scheduler task ${TASK_NAME}` };
}

/** True when the task is registered. */
export async function scheduledTaskInstalled(runner: ProcessRunner): Promise<boolean> {
  const result = await runner.run("schtasks", ["/Query", "/TN", TASK_NAME], { timeoutMs: 15_000 });
  return result.code === 0;
}
