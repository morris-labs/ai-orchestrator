// The host environment the server core runs against: the home directory, the
// container user, and the clock. Tests pass a temporary home and a fixed
// clock; production uses `defaultHostEnv()`.
import os from "node:os";
import path from "node:path";
import { HOME_PATHS } from "@agentbox/contracts";

export interface HostEnv {
  /** The host user's home directory. Every `~` path below resolves against it. */
  home: string;
  /**
   * The server's data directory, which holds the database, the token, the
   * keeper state, the sessions directories, and the 3.x records the import
   * reads. Default: `~/.claude-box`.
   */
  dataDir?: string;
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

/** The environment variable that sets the data directory. */
export const DATA_DIR_ENV = "AGENTBOX_DATA_DIR";

/** The data directory: `env.dataDir` when set, else `~/.claude-box`. */
export function dataDirOf(env: Pick<HostEnv, "home" | "dataDir">): string {
  return env.dataDir ? path.resolve(env.dataDir) : path.join(env.home, HOME_PATHS.dataDir);
}

/**
 * Resolves a `HOME_PATHS` entry under the `~/.claude-box` directory against
 * the data directory instead.
 */
export function dataPath(env: Pick<HostEnv, "home" | "dataDir">, homeRelative: string): string {
  const prefix = `${HOME_PATHS.dataDir}/`;
  if (!homeRelative.startsWith(prefix)) {
    throw new Error(`${homeRelative} isn't under ${HOME_PATHS.dataDir}.`);
  }
  return path.join(dataDirOf(env), homeRelative.slice(prefix.length));
}

/** Paths under the home and data directories that the core reads and writes. */
export function homePaths(env: HostEnv) {
  const at = (rel: string) => path.join(env.home, rel);
  const data = (rel: string) => dataPath(env, rel);
  return {
    dataDir: dataDirOf(env),
    database: data(HOME_PATHS.database),
    config: data(HOME_PATHS.config),
    serverToken: data(HOME_PATHS.serverToken),
    stateDir: data(HOME_PATHS.stateDir),
    sessionsDir: data(HOME_PATHS.sessionsDir),
    backupDir: data(HOME_PATHS.backupDir),
    importReport: data(`${HOME_PATHS.dataDir}/import-report.json`),
    claudeDir: at(".claude"),
    claudeJson: at(".claude.json"),
    claudeProjects: at(".claude/projects"),
    claudeSessions: at(".claude/sessions"),
    codexDir: at(".codex"),
    copilotDir: at(".copilot"),
  };
}

/** `<data dir>/sessions/<name>`: mounted over a container's `~/.claude/sessions`. */
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
