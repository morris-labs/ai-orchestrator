// The systemd user service that runs `agentbox-server`.
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "../api/errors.js";
import type { ProcessRunner } from "../jobs/process.js";

export const SERVICE_NAME = "agentbox-server.service";

/** The unit file path under a home directory. */
export function unitPath(home: string): string {
  return join(home, ".config", "systemd", "user", SERVICE_NAME);
}

/** The content of the user unit. */
export function unitFile(opts: { execStart: string; description?: string }): string {
  return [
    "[Unit]",
    `Description=${opts.description ?? "Agent Box server"}`,
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${opts.execStart}`,
    "Restart=on-failure",
    "RestartSec=2",
    "Environment=NODE_ENV=production",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * Writes the user unit, reloads systemd, and enables and starts the service.
 * Throws `conflict` with systemctl's output when a step fails.
 */
export async function installService(opts: {
  home: string;
  execStart: string;
  runner: ProcessRunner;
  log?: (s: string) => void;
}): Promise<{ path: string }> {
  const path = unitPath(opts.home);
  await mkdir(join(opts.home, ".config", "systemd", "user"), { recursive: true });
  await writeFile(path, unitFile({ execStart: opts.execStart }), { mode: 0o644 });
  opts.log?.(`Wrote ${path}.\r\n`);
  for (const args of [
    ["--user", "daemon-reload"],
    ["--user", "enable", "--now", SERVICE_NAME],
  ]) {
    opts.log?.(`Running: systemctl ${args.join(" ")}\r\n`);
    const result = await opts.runner.run("systemctl", args, { timeoutMs: 30_000 });
    if (result.code !== 0) {
      const output = (result.stderr || result.stdout).trim();
      throw new ApiError(
        "conflict",
        `systemctl ${args.join(" ")} failed${output ? `: ${output}` : "."}`,
      );
    }
  }
  return { path };
}

/** True when the user unit file exists. */
export async function serviceInstalled(home: string): Promise<boolean> {
  try {
    await access(unitPath(home));
    return true;
  } catch {
    return false;
  }
}
