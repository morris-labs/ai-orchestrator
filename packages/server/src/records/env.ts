// The host environment the server core runs against: the home directory, the
// container user, and the clock. Tests pass a temporary home and a fixed
// clock; production uses `defaultHostEnv()`.
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ACCOUNTS_DIR, HOME_PATHS, type Platform } from "@aio/contracts";
import { hostOsOf, type HostOs } from "../platform/host.js";

export interface HostEnv {
  /** The host user's home directory. Every `~` path below resolves against it. */
  home: string;
  /**
   * The server's data directory, which holds the database, the token, the
   * keeper state, the sessions directories, and the 3.x records the import
   * reads. Default: `~/.ai-orchestrator`.
   */
  dataDir?: string;
  /** The user name inside the container; see `containerUsername()`. */
  user: string;
  /** The current time. */
  now: () => Date;
  /**
   * The Claude transcript store root when boxes run on accounts (the
   * shared store described in `docs/accounts.md`), else `undefined` and the host's
   * `~/.claude/projects`. `createServerCore()` sets it from `accountsMode`.
   */
  claudeProjectsRoot?: () => string | undefined;
}

/**
 * Returns the container user name: the first of `USER`, `LOGNAME`, and
 * `USERNAME` that is set, else `user`. A name with whitespace, `:`, or `/`
 * breaks `--user` and bind paths, so it also falls back to `user`.
 *
 * On macOS and Windows the host name isn't a Linux account name, so it's
 * lowercased (Windows names such as `Alex` are common, and `useradd`
 * refuses capitals) and must then be a valid Linux user name, else `user`.
 * The image build gets the same name; see `scripts/build-image.sh --user`.
 */
export function containerUsername(
  env: NodeJS.ProcessEnv = process.env,
  hostOs: HostOs = hostOsOf(process.platform),
): string {
  const name = env.USER || env.LOGNAME || env.USERNAME || "user";
  if (hostOs !== "linux") {
    const lower = name.toLowerCase();
    return /^[a-z_][a-z0-9_-]{0,31}$/.test(lower) ? lower : "user";
  }
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
export const DATA_DIR_ENV = "AIO_DATA_DIR";

/** The data directory: `env.dataDir` when set, else `~/.ai-orchestrator`. */
export function dataDirOf(env: Pick<HostEnv, "home" | "dataDir">): string {
  return env.dataDir ? path.resolve(env.dataDir) : path.join(env.home, HOME_PATHS.dataDir);
}

/**
 * Resolves a `HOME_PATHS` entry under the `~/.ai-orchestrator` directory against
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
    brokerDir: data(HOME_PATHS.brokerDir),
    backupDir: data(HOME_PATHS.backupDir),
    importReport: data(`${HOME_PATHS.dataDir}/import-report.json`),
    /** `DATA_DIR/accounts`: one folder per account, `VENDOR/NAME`. */
    accountsDir: path.join(dataDirOf(env), ACCOUNTS_DIR),
    claudeDir: at(".claude"),
    claudeJson: at(".claude.json"),
    claudeProjects: at(".claude/projects"),
    claudeSessions: at(".claude/sessions"),
    codexDir: at(".codex"),
    copilotDir: at(".copilot"),
  };
}

/** The folder that holds the Claude transcripts: the shared store in accounts mode, else `~/.claude/projects`. */
export function claudeProjectsDir(env: HostEnv): string {
  return env.claudeProjectsRoot?.() ?? homePaths(env).claudeProjects;
}

/** `<data dir>/accounts/<vendor>/<name>`: an account's config folder. */
export function accountDirFor(
  env: Pick<HostEnv, "home" | "dataDir">,
  vendor: Platform,
  name: string,
): string {
  return path.join(dataDirOf(env), ACCOUNTS_DIR, vendor, name);
}

/** `<data dir>/sessions/<name>`: mounted over a container's `~/.claude/sessions`. */
export function sessionsDirFor(env: HostEnv, name: string): string {
  return path.join(homePaths(env).sessionsDir, name);
}

/**
 * The name of a container's broker directory: the first 16 hex digits of the
 * SHA-256 of the container name. A Unix socket path holds at most 107 bytes,
 * and a container name grows with its project directory's name, so the
 * directory gets a short name of fixed length instead.
 */
export function brokerDirName(container: string): string {
  return crypto.createHash("sha256").update(container).digest("hex").slice(0, 16);
}

/**
 * `<data dir>/broker/<hash>`: the directory of the container's secrets broker
 * socket, mounted read-only at `BROKER_MOUNT`. See `brokerDirName`.
 */
export function brokerDirFor(env: Pick<HostEnv, "home" | "dataDir">, container: string): string {
  return path.join(dataPath(env, HOME_PATHS.brokerDir), brokerDirName(container));
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
