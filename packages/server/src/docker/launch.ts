// The launch parameters of a project container, described once (3.3.5
// `DockerBackend::launchSpec`, inventory sections 4.1 and 4.2), minus the
// port pool, plus the engine port, the engine environment, project TCP maps,
// and secret environment.
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ENGINE_PORT, ENGINE_ENV, type Mount, type TcpMap } from "@agentbox/contracts";
import { RESERVED_ENV_NAMES } from "../records/settings.js";
import {
  containerHome,
  homePaths,
  hostToContainer,
  sessionsDirFor,
  type HostEnv,
} from "../records/env.js";
import { STARTUP_GRACE_SEC, STATE_MOUNT, sharedKeeperCommand } from "./scripts.js";
import { ENGINE_TOKEN_FILE_ENV, ENGINE_TOKEN_FILE_NAME, prepareStateDir } from "./state.js";
import type { ContainerCreateSpec } from "./types.js";

/** Labels the server sets on every project container. */
export const LABELS = {
  project: "agentbox.project",
  tcpMaps: "agentbox.tcp-maps",
  secretNames: "agentbox.secret-names",
  engineVersion: "agentbox.engine-version",
} as const;

export interface LaunchInput {
  /** `projectContainerName(projectId)`. */
  container: string;
  projectId: string;
  /** The project root on the host. */
  root: string;
  /** The project's own mounts. */
  mounts: readonly Mount[];
  /** The global mounts; one whose container path the project already uses is dropped. */
  globalMounts: readonly Mount[];
  tcpMaps: readonly TcpMap[];
  image: string;
  engine: { hostPort: number; token: string; version: string };
  /** Resolved secrets and any other environment the server adds. Never logged. */
  extraEnv: Readonly<Record<string, string>>;
  /** Seconds the keeper lingers with no sessions; 30 unless a test shortens it. */
  graceSec?: number;
}

/** What the launch needs to know about the host, gathered by `prepareLaunchHost()`. */
export interface LaunchHostFacts {
  /** The target of `~/.claude/projects` when it is a symlink out of `~/.claude`. */
  projectsSymlinkTarget: string | null;
  /** Whether `<root>/gitconfig` exists. */
  hasGitconfig: boolean;
}

/**
 * Returns the merged mount list: the project's own mounts, then each global
 * mount whose container path is not already used.
 */
export function mergeMounts(own: readonly Mount[], global: readonly Mount[]): Mount[] {
  const clean = (p: string) => {
    const n = path.posix.normalize(p);
    return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
  };
  const out = [...own];
  const used = new Set(own.map((m) => clean(m.container)));
  for (const m of global) {
    const c = clean(m.container);
    if (used.has(c)) continue;
    used.add(c);
    out.push(m);
  }
  return out;
}

/** A mount as a docker bind string, with the host side made absolute. */
export function mountBind(m: Mount): string {
  return `${path.resolve(m.host)}:${m.container}`;
}

/**
 * The extra bind needed when `~/.claude/projects` is a symlink to a place
 * outside `~/.claude`: only `~/.claude` is mounted, so the link would dangle
 * in the container and `claude --resume` would find no transcript. Returns
 * the link target, or `null`.
 */
export function projectsSymlinkTarget(env: HostEnv): string | null {
  const { claudeProjects, claudeDir } = homePaths(env);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(claudeProjects);
  } catch {
    return null;
  }
  if (!st.isSymbolicLink()) return null;
  const target = path.resolve(path.dirname(claudeProjects), fs.readlinkSync(claudeProjects));
  let resolvedClaude: string;
  try {
    resolvedClaude = fs.realpathSync(claudeDir);
  } catch {
    resolvedClaude = claudeDir;
  }
  if (target === resolvedClaude || target.startsWith(`${resolvedClaude}/`)) return null;
  return target;
}

/**
 * Creates the host directories docker would otherwise create as root
 * (`~/.claude/sessions`, `~/.codex`, `~/.copilot`), empties the container's
 * sessions directory, clears a stale keeper state file, and gathers the host
 * facts the launch spec needs.
 */
export function prepareLaunchHost(
  env: HostEnv,
  input: Pick<LaunchInput, "container" | "root">,
): LaunchHostFacts {
  const paths = homePaths(env);
  for (const dir of [paths.claudeSessions, paths.codexDir, paths.copilotDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const sessions = sessionsDirFor(env, input.container);
  fs.rmSync(sessions, { recursive: true, force: true });
  fs.mkdirSync(sessions, { recursive: true });
  prepareStateDir(env, input.container, STATE_MOUNT);
  return {
    projectsSymlinkTarget: projectsSymlinkTarget(env),
    hasGitconfig: fs.existsSync(path.join(input.root, "gitconfig")),
  };
}

/** Builds the container's create body. Pure: every host fact comes in through `facts`. */
export function buildLaunchSpec(
  env: HostEnv,
  input: LaunchInput,
  facts: LaunchHostFacts,
): ContainerCreateSpec {
  const home = containerHome(env);
  const paths = homePaths(env);
  const containerDir = hostToContainer(input.root);

  const binds = [
    `${input.root}:${containerDir}`,
    `${paths.claudeDir}:${home}/.claude`,
    `${paths.claudeJson}:${home}/.claude.json`,
    `${paths.codexDir}:${home}/.codex`,
    `${paths.copilotDir}:${home}/.copilot`,
  ];
  if (facts.projectsSymlinkTarget) {
    const b = `${facts.projectsSymlinkTarget}:${facts.projectsSymlinkTarget}`;
    if (!binds.includes(b)) binds.push(b);
  }
  binds.push(`${sessionsDirFor(env, input.container)}:${home}/.claude/sessions`);
  for (const m of mergeMounts(input.mounts, input.globalMounts)) binds.push(mountBind(m));
  binds.push(`${path.join(paths.stateDir, input.container)}:${STATE_MOUNT}`);

  const envList = ["IS_SANDBOX=1", "DISABLE_AUTOUPDATER=1"];
  if (facts.hasGitconfig) envList.push(`GIT_CONFIG_GLOBAL=${containerDir}/gitconfig`);
  // The engine token is not in this list: `writeEngineTokenFile()` puts it in
  // the state directory, out of reach of the environment `docker exec`
  // passes to every session.
  envList.push(
    `${ENGINE_TOKEN_FILE_ENV}=${STATE_MOUNT}/${ENGINE_TOKEN_FILE_NAME}`,
    `${ENGINE_ENV.port}=${DEFAULT_ENGINE_PORT}`,
    `${ENGINE_ENV.projectRoot}=${containerDir}`,
    `${ENGINE_ENV.container}=${input.container}`,
    `${ENGINE_ENV.engineVersion}=${input.engine.version}`,
    `${ENGINE_ENV.stateDir}=${STATE_MOUNT}`,
  );
  // A reserved name never reaches the container from a secret, even one
  // stored before the settings refused it.
  const secretNames = Object.keys(input.extraEnv)
    .filter((n) => !RESERVED_ENV_NAMES.has(n))
    .sort();
  for (const name of secretNames) envList.push(`${name}=${input.extraEnv[name]}`);

  const portBindings: ContainerCreateSpec["portBindings"] = {
    [`${DEFAULT_ENGINE_PORT}/tcp`]: [
      { hostIp: "127.0.0.1", hostPort: String(input.engine.hostPort) },
    ],
  };
  for (const t of input.tcpMaps) {
    portBindings[`${t.container}/tcp`] = [{ hostIp: "", hostPort: String(t.host) }];
  }

  return {
    name: input.container,
    image: input.image,
    user: env.user,
    workingDir: containerDir,
    cmd: sharedKeeperCommand(input.graceSec ?? STARTUP_GRACE_SEC),
    env: envList,
    binds,
    portBindings,
    labels: {
      [LABELS.project]: input.projectId,
      [LABELS.tcpMaps]: tcpMapsLabel(input.tcpMaps),
      [LABELS.secretNames]: secretNames.join(","),
      [LABELS.engineVersion]: input.engine.version,
    },
    tty: true,
    openStdin: true,
    autoRemove: true,
  };
}

/** The `agentbox.tcp-maps` label value: sorted `HOST:CONTAINER` pairs, comma-separated. */
export function tcpMapsLabel(maps: readonly TcpMap[]): string {
  return maps
    .map((t) => `${t.host}:${t.container}`)
    .sort()
    .join(",");
}

/**
 * The same spec as a `docker run` command line, for logs, docs, and the host
 * test scripts. Environment values are masked except the fixed ones, so the
 * result is safe to print.
 */
export function toDockerRunArgs(
  spec: ContainerCreateSpec,
  options: { maskEnv?: boolean } = {},
): string[] {
  const mask = options.maskEnv ?? true;
  const shown = new Set([
    "IS_SANDBOX",
    "DISABLE_AUTOUPDATER",
    "GIT_CONFIG_GLOBAL",
    ENGINE_TOKEN_FILE_ENV,
    ENGINE_ENV.port,
    ENGINE_ENV.projectRoot,
    ENGINE_ENV.container,
    ENGINE_ENV.engineVersion,
    ENGINE_ENV.stateDir,
  ]);
  const args = ["run", "-d", "-i", "-t"];
  if (spec.autoRemove) args.push("--rm");
  args.push("--name", spec.name, "--user", spec.user);
  for (const e of spec.env) {
    const name = e.slice(0, e.indexOf("="));
    args.push("-e", mask && !shown.has(name) ? `${name}=***` : e);
  }
  args.push("-w", spec.workingDir);
  for (const b of spec.binds) args.push("-v", b);
  for (const [port, bindings] of Object.entries(spec.portBindings)) {
    for (const b of bindings) {
      const containerPort = port.replace(/\/tcp$/, "");
      args.push(
        "-p",
        b.hostIp ? `${b.hostIp}:${b.hostPort}:${containerPort}` : `${b.hostPort}:${containerPort}`,
      );
    }
  }
  for (const [k, v] of Object.entries(spec.labels)) args.push("--label", `${k}=${v}`);
  args.push(spec.image, ...spec.cmd);
  return args;
}
