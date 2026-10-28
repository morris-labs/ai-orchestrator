// The host environment the server core runs against: the home directory, the
// container user, and the clock. Tests pass a temporary home and a fixed
// clock; production uses `defaultHostEnv()`.
import os from "node:os";
import path from "node:path";
import { HOME_PATHS } from "@agentbox/contracts";

export interface HostEnv {
  /** The host user's home directory. Every `~` path below resolves against it. */
  home: string;
  /** The user name inside the container; see `containerUsername()`. */
  user: string;
  /** The current time. */
  now: () => Date;
}

/**
 * Returns the container user name: the first of `USER`, `LOGNAME`, and
 * `USERNAME` that is set, else `user`. A name with whitespace, `:`, or `/`
 * breaks `--user` and bind paths, so it also falls back to `user`.
 */
export function containerUsername(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.USER || env.LOGNAME || env.USERNAME || "user";
  return /[\s:/]/.test(name) ? "user" : name;
}

/** The environment of the running process. */
export function defaultHostEnv(): HostEnv {
  return { home: os.homedir(), user: containerUsername(), now: () => new Date() };
}

/** The user's home directory inside the container. */
export function containerHome(env: HostEnv): string {
  return `/home/${env.user}`;
}

/** Paths under the home directory that the core reads and writes. */
export function homePaths(env: HostEnv) {
  const at = (rel: string) => path.join(env.home, rel);
  return {
    dataDir: at(HOME_PATHS.dataDir),
    database: at(HOME_PATHS.database),
    config: at(HOME_PATHS.config),
    stateDir: at(HOME_PATHS.stateDir),
    sessionsDir: at(HOME_PATHS.sessionsDir),
    backupDir: at(HOME_PATHS.backupDir),
    importReport: at(`${HOME_PATHS.dataDir}/import-report.json`),
    claudeDir: at(".claude"),
    claudeJson: at(".claude.json"),
    claudeProjects: at(".claude/projects"),
    claudeSessions: at(".claude/sessions"),
    codexDir: at(".codex"),
    copilotDir: at(".copilot"),
  };
}

/** `~/.claude-box/sessions/<name>`: mounted over a container's `~/.claude/sessions`. */
export function sessionsDirFor(env: HostEnv, name: string): string {
  return path.join(homePaths(env).sessionsDir, name);
}

/**
 * Maps a host path to the path the container sees. On Linux the project is
 * mounted at its own host path, so this is the absolute, cleaned path.
 */
export function hostToContainer(hostPath: string): string {
  return path.resolve(hostPath);
}

/**
 * Splits a `HOST[:CONTAINER]` mount string at its first colon. The container
 * part is empty when absent.
 */
export function splitMountSpec(spec: string): { host: string; container: string } {
  const colon = spec.indexOf(":");
  return colon < 0
    ? { host: spec, container: "" }
    : { host: spec.slice(0, colon), container: spec.slice(colon + 1) };
}

/** Writes a container path with the container user's home as `~`. */
export function displayPath(containerPath: string, home: string): string {
  if (containerPath === home) return "~";
  if (containerPath.startsWith(`${home}/`)) return `~${containerPath.slice(home.length)}`;
  return containerPath;
}

/** A host path as an agent is told about it: the container path with `~` for its home. */
export function promptPath(env: HostEnv, hostPath: string): string {
  return displayPath(hostToContainer(hostPath), containerHome(env));
}

/** `yyyyMMddHHmmss` in local time, as the 3.3.5 backups and archives name themselves. */
export function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}
