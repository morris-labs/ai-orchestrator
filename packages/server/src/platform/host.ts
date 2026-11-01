// The host operating system behind one injectable value, so that code with
// a branch per operating system can be tested on any of them.
//
// "Platform" elsewhere in the server means the agent CLI a box runs
// (claude, codex, or copilot). This module is about the host operating
// system instead, so its types say `HostPlatform` and `HostOs`.
//
// Linux behavior must stay exactly as it was before this module existed:
// every Linux branch returns what the code returned when it had no branch.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME_PATHS, hostOsFrom, type HostOs } from "@aio/contracts";
import { defaultHostEnv, hostOsOf, type HostEnv } from "../records/env.js";

// One host OS mechanism for the whole server: the `HostOs` type and
// `hostOsFrom()` from the contracts, and `HostEnv.hostOs` for the running
// server, which `hostOsOf()` reads.
export { hostOsFrom, hostOsOf, type HostOs };

/** The service manager that starts the server at login on each host. */
export type ServiceManagerKind = "systemd" | "launchd" | "schtasks";

export interface HostPlatform {
  os: HostOs;
  /** The user's home directory. */
  home: string;
  /** The environment the server runs with. */
  env: NodeJS.ProcessEnv;
  /** The user's numeric id, for `launchctl` domains on macOS. `undefined` on Windows. */
  uid?: number;
  /** Whether a path exists. Tests replace it. */
  exists: (p: string) => boolean;
}

/**
 * The host the process runs on, with its OS from `env.hostOs`. Pass `home`
 * to use another home directory, as `AIO_HOME` does, and `env` to share the
 * core's `HostEnv`. Default: `defaultHostEnv()`, from `process.platform`.
 */
export function currentPlatform(
  home: string = os.homedir(),
  env: Pick<HostEnv, "hostOs"> = defaultHostEnv(),
): HostPlatform {
  return {
    os: hostOsOf(env),
    home,
    env: process.env,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    exists: existsSync,
  };
}

/** A host for tests and for callers that know the answer: defaults fill what isn't given. */
export function hostPlatform(
  hostOs: HostOs,
  options: Partial<Omit<HostPlatform, "os">> = {},
): HostPlatform {
  return {
    os: hostOs,
    home:
      options.home ??
      (hostOs === "win32" ? "C:\\Users\\user" : hostOs === "darwin" ? "/Users/user" : "/home/user"),
    env: options.env ?? {},
    uid: options.uid ?? (hostOs === "win32" ? undefined : 501),
    exists: options.exists ?? (() => false),
  };
}

/** The `path` functions with the host's separator. */
export function pathFor(p: Pick<HostPlatform, "os">): path.PlatformPath {
  return p.os === "win32" ? path.win32 : path.posix;
}

/**
 * The default data directory: `~/.ai-orchestrator` on every host.
 *
 * macOS and Windows have their own conventions (`~/Library/Application
 * Support` and `%LOCALAPPDATA%`), but the data directory stays in the home
 * directory on all three for these reasons:
 *
 * - The CLI, both apps, and the server find it with one rule, and docs and
 *   `AIO_DATA_DIR` work the same everywhere.
 * - Containers bind-mount folders inside it (state, sessions, accounts,
 *   transcripts). Docker Desktop shares the home directory by default, and
 *   a path without spaces avoids quoting problems in mount specifications
 *   (`Application Support` has a space).
 * - The transcript store must sit at the same path inside the container
 *   as on the host; a short path under the home directory keeps that
 *   mapping simple. See the `claude/win-paths` work for Windows.
 */
export function defaultDataDir(p: Pick<HostPlatform, "os" | "home">): string {
  return pathFor(p).join(p.home, HOME_PATHS.dataDir);
}

/**
 * The configuration directory for files that the user writes and the
 * server only reads, such as an `op.env` file that holds the 1Password
 * service account token for the service.
 *
 * - Linux: `$XDG_CONFIG_HOME/aio`, else `~/.config/aio`.
 * - macOS: `~/.config/aio`, which command-line tools such as `op` and `gh`
 *   also use on macOS.
 * - Windows: `%APPDATA%\aio`, else `~\AppData\Roaming\aio`.
 */
export function configDir(p: Pick<HostPlatform, "os" | "home" | "env">): string {
  const join = pathFor(p).join;
  if (p.os === "win32") {
    return join(p.env.APPDATA || join(p.home, "AppData", "Roaming"), "aio");
  }
  if (p.os === "linux" && p.env.XDG_CONFIG_HOME) return join(p.env.XDG_CONFIG_HOME, "aio");
  return join(p.home, ".config", "aio");
}

/** The Docker Desktop named pipe on Windows. */
export const WINDOWS_DOCKER_PIPE = "//./pipe/docker_engine";

/**
 * The Unix sockets that Docker runtimes on macOS listen on, in the order
 * they are tried: the system socket that Docker Desktop links by default,
 * then the per-user sockets of Docker Desktop, Colima, OrbStack, and
 * Rancher Desktop.
 */
export const MAC_DOCKER_SOCKETS = [
  "/var/run/docker.sock",
  "~/.docker/run/docker.sock",
  "~/.colima/default/docker.sock",
  "~/.orbstack/run/docker.sock",
  "~/.rd/docker.sock",
] as const;

/** Where the server connects to the Docker Engine API. */
export type DockerEndpoint =
  /** dockerode's own default: `DOCKER_HOST` when set, else the platform socket. */
  { kind: "default" } | { kind: "socket"; socketPath: string };

/**
 * The Docker endpoint for the host.
 *
 * - `DOCKER_HOST` set, on any host: dockerode's default, which reads it.
 * - Linux: dockerode's default, `/var/run/docker.sock`, as before.
 * - Windows: the Docker Desktop named pipe, which is also dockerode's
 *   default there; it's named here so that messages and docs agree.
 * - macOS: the first socket in `MAC_DOCKER_SOCKETS` that exists, else
 *   `/var/run/docker.sock`. Docker Desktop creates that one only when
 *   "Allow the default Docker socket to be used" is on, so a per-user
 *   socket must be found when it's off.
 */
export function dockerEndpoint(p: HostPlatform): DockerEndpoint {
  if (p.env.DOCKER_HOST) return { kind: "default" };
  if (p.os === "win32") return { kind: "socket", socketPath: WINDOWS_DOCKER_PIPE };
  if (p.os === "linux") return { kind: "default" };
  for (const candidate of MAC_DOCKER_SOCKETS) {
    const resolved = candidate.startsWith("~/")
      ? path.posix.join(p.home, candidate.slice(2))
      : candidate;
    if (p.exists(resolved)) return { kind: "socket", socketPath: resolved };
  }
  return { kind: "socket", socketPath: MAC_DOCKER_SOCKETS[0] };
}

/** The dockerode constructor options for an endpoint: `undefined` keeps dockerode's default. */
export function dockerodeOptions(endpoint: DockerEndpoint): { socketPath: string } | undefined {
  return endpoint.kind === "socket" ? { socketPath: endpoint.socketPath } : undefined;
}

/** The service manager that starts the server at login. */
export function serviceManagerOf(p: Pick<HostPlatform, "os">): ServiceManagerKind {
  return p.os === "darwin" ? "launchd" : p.os === "win32" ? "schtasks" : "systemd";
}

/**
 * The argv that opens a file, directory, or URL with its default handler:
 * `xdg-open` on Linux, `open` on macOS, and `explorer.exe` on Windows.
 * `explorer.exe` takes the target as one argument, so no shell parses it,
 * unlike `cmd /c start`.
 */
export function openerArgv(p: Pick<HostPlatform, "os">, target: string): string[] {
  if (p.os === "darwin") return ["open", target];
  if (p.os === "win32") return ["explorer.exe", target];
  return ["xdg-open", target];
}

/**
 * The argv that runs `argv` under a pseudo-terminal, for programs that
 * prompt on a terminal, or `null` when the host has no such wrapper and the
 * program must run without one.
 *
 * - Linux: util-linux `script -q -f -e -c COMMAND /dev/null`, as before.
 *   `commandLine` is the POSIX-quoted command; util-linux runs it with
 *   `$SHELL -c`.
 * - macOS: BSD `script -q /dev/null PROGRAM ARGS...`, which takes the argv
 *   directly. It has no `-c`, `-f`, or `-e`; it flushes as it goes, and
 *   exits with the program's status.
 * - Windows: `null`. There is no `script`, and a ConPTY needs a native
 *   module the server doesn't ship, so `ssh-copy-id` (which Windows
 *   doesn't have either) and the image build run without a terminal.
 */
export function ptyArgv(
  p: Pick<HostPlatform, "os">,
  argv: readonly string[],
  commandLine: string,
): string[] | null {
  if (p.os === "win32") return null;
  if (p.os === "darwin") return ["script", "-q", "/dev/null", ...argv];
  return ["script", "-q", "-f", "-e", "-c", commandLine, "/dev/null"];
}

/** Whether the file system has POSIX permission bits that `chmod` can set. Windows has ACLs instead. */
export function hasPosixModes(p: Pick<HostPlatform, "os">): boolean {
  return p.os !== "win32";
}

/**
 * Where Git for Windows puts `bash.exe`, in the order they are tried:
 * the per-machine install, then the per-user install.
 */
export function gitBashCandidates(p: Pick<HostPlatform, "home" | "env">): string[] {
  const join = path.win32.join;
  const programFiles = p.env.ProgramFiles || "C:\\Program Files";
  const localAppData = p.env.LOCALAPPDATA || join(p.home, "AppData", "Local");
  return [
    join(programFiles, "Git", "bin", "bash.exe"),
    join(localAppData, "Programs", "Git", "bin", "bash.exe"),
  ];
}

/**
 * The argv that runs a bash script: the script itself on Linux and macOS,
 * whose shebang finds bash, and Git for Windows' `bash.exe` on Windows, or
 * `null` when it isn't installed. `AIO_BASH` names another bash on any host.
 */
export function bashScriptArgv(
  p: HostPlatform,
  script: string,
  args: readonly string[],
): string[] | null {
  const own = p.env.AIO_BASH;
  if (own) return [own, script, ...args];
  if (p.os !== "win32") return [script, ...args];
  const bash = gitBashCandidates(p).find((c) => p.exists(c));
  return bash ? [bash, script, ...args] : null;
}

/** What to install when a tool is missing, worded for the host's package manager. */
export function installHint(p: Pick<HostPlatform, "os">, tool: "docker" | "ssh"): string {
  if (tool === "docker") {
    if (p.os === "darwin")
      return "Install and start Docker Desktop (or Colima or OrbStack), then check again.";
    if (p.os === "win32")
      return "Install and start Docker Desktop with the WSL 2 backend, then check again.";
    return "Install Docker, start the daemon, and add your user to the docker group, then check again.";
  }
  if (p.os === "darwin") return "macOS includes the ssh client; check that /usr/bin/ssh exists.";
  if (p.os === "win32") {
    return "Add the OpenSSH Client optional feature in Settings > System > Optional features.";
  }
  return "Install the ssh client with sudo apt install openssh-client.";
}

/**
 * The longest Unix socket path, in bytes without the terminating null:
 * `sun_path` holds 108 bytes on Linux and Windows and 104 on macOS.
 */
export function maxSocketPathBytes(hostOs: HostOs): number {
  return hostOs === "darwin" ? 103 : 107;
}

/**
 * The one user name the container image is built with and every container
 * runs as (`docker exec --user`, the image's `USER_NAME` build argument):
 * see `containerUsername` in `records/env.ts`, which this calls. On Linux
 * it's the host name as before; on macOS and Windows it's lowercased and
 * must be a valid Linux user name, else `user`. The server passes it to
 * `scripts/build-image.sh --user` on macOS and Windows, so the build never
 * falls back to `id -un` there.
 */
export function imageUserArgs(p: Pick<HostPlatform, "os" | "env">, name: string): string[] {
  return p.os === "linux" ? [] : ["--user", name];
}

/** The variables that `op.env` may set: the 1Password CLI's own. */
const OP_ENV_NAME = /^OP_[A-Z0-9_]+$/;

/**
 * Reads `op.env` in the configuration directory on macOS and Windows and
 * returns the `OP_*` variables it sets that `p.env` doesn't already have,
 * such as `OP_SERVICE_ACCOUNT_TOKEN`. On Linux the systemd unit loads the
 * same file with `EnvironmentFile=`, so this returns nothing there.
 *
 * The file holds `NAME=VALUE` lines; blank lines and `#` comments are
 * skipped, and one pair of surrounding quotes is removed. Other names are
 * ignored, so the file can't change the server's `PATH` or Node.js options.
 * Values are never logged.
 */
export function serviceEnvFromFile(
  p: Pick<HostPlatform, "os" | "home" | "env">,
  read: (file: string) => string | null,
): Record<string, string> {
  if (p.os === "linux") return {};
  const text = read(pathFor(p).join(configDir(p), "op.env"));
  if (text === null) return {};
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    if (OP_ENV_NAME.test(name) && p.env[name] === undefined) out[name] = value;
  }
  return out;
}
