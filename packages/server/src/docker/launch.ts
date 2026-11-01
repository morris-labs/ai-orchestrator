// The launch parameters of a project container, described once (3.3.5
// `DockerBackend::launchSpec`, inventory sections 4.1 and 4.2), minus the
// port pool, plus the engine port, the engine environment, project TCP maps,
// and the secrets broker mount. Secret values never reach the spec: the
// container asks the broker for them (docs/v4/design-secrets-broker.md).
import fs from "node:fs";
import path from "node:path";
import {
  BROKER_ENV,
  BROKER_MOUNT,
  BROKER_SOCKET_PATH,
  DEFAULT_ENGINE_PORT,
  ENGINE_ENV,
  hostPathProblem,
  mountProblem,
  type Mount,
  type TcpMap,
} from "@agentbox/contracts";
import { ApiError } from "../records/errors.js";
import { RESERVED_ENV_NAMES } from "../records/settings.js";
import {
  brokerDirFor,
  containerHome,
  homePaths,
  hostToContainer,
  sessionsDirFor,
  type HostEnv,
} from "../records/env.js";
import { STARTUP_GRACE_SEC, STATE_MOUNT, sharedKeeperCommand } from "./scripts.js";
import { ENGINE_TOKEN_FILE_NAME, prepareStateDir } from "./state.js";
import type { ContainerCreateSpec } from "./types.js";

/** Labels the server sets on every project container. */
export const LABELS = {
  project: "agentbox.project",
  tcpMaps: "agentbox.tcp-maps",
  secretNames: "agentbox.secret-names",
  engineVersion: "agentbox.engine-version",
  /** `password` when the container user's sudo asks for a password, `off` when sudo is off. */
  sudo: "agentbox.sudo",
  /**
   * `broker` when secrets come from the broker socket. A container without
   * the label has its secret values in its environment.
   */
  secrets: "agentbox.secrets",
  /** `accounts` when the container mounts the account folders; absent or `host` otherwise. */
  accountsMode: "agentbox.accounts-mode",
} as const;

/** The `agentbox.secrets` label value of a container that gets secrets from the broker. */
export const SECRETS_LABEL_BROKER = "broker";

/** The `agentbox.sudo` label value for a container with or without a sudo password. */
export function sudoLabel(passwordSet: boolean): "password" | "off" {
  return passwordSet ? "password" : "off";
}

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
  /**
   * The names of the secrets the container may request from the broker, for
   * the `agentbox.secret-names` label. The values never enter the spec.
   */
  secretNames: readonly string[];
  /**
   * Plain variables that the host test scripts add, such as
   * `AGENTBOX_MOCK_VENDORS`. Never secrets: `docker inspect` shows them. A
   * name the server sets itself is dropped.
   */
  extraEnv?: Readonly<Record<string, string>>;
  /** Seconds the keeper lingers with no sessions; 30 unless a test shortens it. */
  graceSec?: number;
  /** Whether the root setup step installs a sudo password; false means sudo is off. */
  sudoPassword?: boolean;
  /**
   * Present when boxes run on accounts (`accountsMode: "accounts"`): the host
   * folders of the Claude accounts. The launch then mounts `DATA_DIR/accounts`
   * and not the host's agent folders.
   */
  accounts?: { claudeDirs: readonly string[] };
}

/** What the launch needs to know about the host, gathered by `prepareLaunchHost()`. */
export interface LaunchHostFacts {
  /**
   * Host mode: the host paths to bind at their own paths so that
   * `~/.claude/projects` resolves in the container. Empty when it is not a
   * link, or leads only inside `~/.claude`.
   */
  projectsLinkMounts: string[];
  /** Whether `<root>/gitconfig` exists. */
  hasGitconfig: boolean;
  /**
   * Accounts mode: the targets of symbolic links at the top of each Claude
   * account folder that point outside it, such as a `projects` link to the
   * shared transcript store. Each is bound at its own path.
   */
  accountLinkTargets?: string[];
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
 * The container paths of the project root and its merged mounts: the paths
 * whose root-owned parents the root setup step gives the container user.
 */
export function mountContainerPaths(
  input: Pick<LaunchInput, "root" | "mounts" | "globalMounts">,
  accountsDir?: string,
): string[] {
  return [
    hostToContainer(input.root),
    ...mergeMounts(input.mounts, input.globalMounts).map((m) => m.container),
    ...(accountsDir === undefined ? [] : [hostToContainer(accountsDir)]),
  ];
}

/**
 * The extra binds needed when `~/.claude/projects` is a link that leaves
 * `~/.claude`: only `~/.claude` is mounted, so the link would dangle in the
 * container and `claude --resume` would find no transcript.
 *
 * Follows the whole chain. The container reads the link literally, so each
 * hop's target path must exist there. Returns every hop target outside
 * `~/.claude` that exists, then the final real path, each to bind at its own
 * path. Docker follows a link used as a bind source, so a hop's path ends up
 * showing the final folder, and the chain resolves in the container whether
 * the link leads straight to the store or through other links. Empty when
 * `projects` is not a link, dangles, or stays inside `~/.claude`.
 */
export function projectsLinkMounts(env: HostEnv): string[] {
  const { claudeProjects, claudeDir } = homePaths(env);
  let resolvedClaude: string;
  try {
    resolvedClaude = fs.realpathSync(claudeDir);
  } catch {
    resolvedClaude = claudeDir;
  }
  const insideClaude = (p: string): boolean =>
    [claudeDir, resolvedClaude].some((c) => p === c || p.startsWith(`${c}/`));
  const out: string[] = [];
  const add = (p: string): void => {
    if (!insideClaude(p) && !out.includes(p)) out.push(p);
  };
  let current = claudeProjects;
  for (let hops = 0; hops < 40; hops += 1) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(current);
    } catch {
      return [];
    }
    if (!st.isSymbolicLink()) break;
    const target = path.resolve(path.dirname(current), fs.readlinkSync(current));
    add(target);
    current = target;
  }
  let real: string;
  try {
    real = fs.realpathSync(claudeProjects);
  } catch {
    return [];
  }
  add(real);
  return out;
}

/**
 * The existing targets of the symbolic links directly inside an account
 * folder that lead outside it. Generalizes `projectsLinkMounts()`: only
 * the account folders are mounted, so such a link would dangle in the
 * container and `claude --resume` would find no transcript.
 */
export function linkTargetsOutside(accountDir: string): string[] {
  let realDir: string;
  let names: string[];
  try {
    realDir = fs.realpathSync(accountDir);
    names = fs.readdirSync(accountDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    const link = path.join(accountDir, name);
    try {
      if (!fs.lstatSync(link).isSymbolicLink()) continue;
      const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
      if (target === realDir || target.startsWith(`${realDir}/`)) continue;
      if (target === accountDir || target.startsWith(`${accountDir}/`)) continue;
      fs.statSync(target);
      if (!out.includes(target)) out.push(target);
    } catch {
      // A dangling link has nothing to mount.
    }
  }
  return out;
}

/**
 * Capabilities every project container drops. Neither is one `sudo` needs
 * (it needs `SETUID`, `SETGID`, and a setuid binary, which stay), and each
 * would let container root leave something on a host bind mount that
 * escalates on the host: a device node (`MKNOD`) or a binary with file
 * capabilities (`SETFCAP`). Container root can still leave a setuid-root
 * file; docs/architecture.md describes that risk.
 */
export const DROPPED_CAPABILITIES = ["MKNOD", "SETFCAP"] as const;

/**
 * Creates the host directories docker would otherwise create as root
 * (`~/.claude/sessions`, `~/.codex`, `~/.copilot`) and an empty
 * `~/.claude.json` when there is none, which docker would otherwise create as
 * a root-owned directory; creates the container's broker directory; empties the container's sessions directory, clears
 * a stale keeper state file, and gathers the host facts the launch spec
 * needs.
 */
export function prepareLaunchHost(
  env: HostEnv,
  input: Pick<LaunchInput, "container" | "root" | "accounts">,
): LaunchHostFacts {
  const paths = homePaths(env);
  const accountsMode = input.accounts !== undefined;
  if (accountsMode) {
    fs.mkdirSync(paths.accountsDir, { recursive: true, mode: 0o700 });
  } else {
    for (const dir of [paths.claudeSessions, paths.codexDir, paths.copilotDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  const accountLinkTargets: string[] = [];
  for (const dir of input.accounts?.claudeDirs ?? []) {
    // The mount point of the per-container sessions directory.
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true, mode: 0o700 });
    for (const target of linkTargetsOutside(dir)) {
      if (!accountLinkTargets.includes(target)) accountLinkTargets.push(target);
    }
  }
  // The broker listens here; created now so docker doesn't create it as root.
  const broker = brokerDirFor(env, input.container);
  fs.mkdirSync(broker, { recursive: true, mode: 0o700 });
  fs.chmodSync(broker, 0o700);
  if (!accountsMode) {
    try {
      fs.writeFileSync(paths.claudeJson, "{}\n", { mode: 0o600, flag: "wx" });
    } catch (err) {
      // An existing file, or a link to one, is the user's own: leave it.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  const sessions = sessionsDirFor(env, input.container);
  fs.rmSync(sessions, { recursive: true, force: true });
  fs.mkdirSync(sessions, { recursive: true });
  prepareStateDir(env, input.container, STATE_MOUNT);
  return {
    projectsLinkMounts: accountsMode ? [] : projectsLinkMounts(env),
    hasGitconfig: fs.existsSync(path.join(input.root, "gitconfig")),
    ...(accountsMode ? { accountLinkTargets } : {}),
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
  // A bad path otherwise reaches docker as a bind it refuses with a 400, or
  // a relative one that it takes for a named volume.
  const rootProblem = hostPathProblem(input.root);
  if (rootProblem)
    throw new ApiError("validation", `The project root can't be mounted: ${rootProblem}`);
  const merged = mergeMounts(input.mounts, input.globalMounts);
  for (const m of merged) {
    const problem = mountProblem(m);
    if (problem) throw new ApiError("validation", `The mount ${m.host} can't be used: ${problem}`);
  }
  const containerDir = hostToContainer(input.root);

  const binds = [`${input.root}:${containerDir}`];
  if (input.accounts) {
    // One mount for every account, at its host path, so an account added
    // later appears without a restart. Each Claude account's `sessions`
    // folder is this container's own directory, so containers never share
    // `PID.json` files.
    const accountsDir = hostToContainer(paths.accountsDir);
    binds.push(`${paths.accountsDir}:${accountsDir}`);
    for (const dir of input.accounts.claudeDirs) {
      binds.push(`${sessionsDirFor(env, input.container)}:${hostToContainer(dir)}/sessions`);
    }
    for (const target of facts.accountLinkTargets ?? []) {
      const b = `${target}:${target}`;
      if (!binds.includes(b)) binds.push(b);
    }
  } else {
    binds.push(
      `${paths.claudeDir}:${home}/.claude`,
      `${paths.claudeJson}:${home}/.claude.json`,
      `${paths.codexDir}:${home}/.codex`,
      `${paths.copilotDir}:${home}/.copilot`,
    );
    for (const p of facts.projectsLinkMounts) {
      const b = `${p}:${p}`;
      if (!binds.includes(b)) binds.push(b);
    }
    binds.push(`${sessionsDirFor(env, input.container)}:${home}/.claude/sessions`);
  }
  for (const m of merged) binds.push(mountBind(m));
  binds.push(`${path.join(paths.stateDir, input.container)}:${STATE_MOUNT}`);
  // Read-only, so the container can't remove or replace the socket;
  // connecting to it needs no write access. The directory, not the socket,
  // is mounted, so a socket the server recreates stays reachable.
  binds.push(`${brokerDirFor(env, input.container)}:${BROKER_MOUNT}:ro`);

  const envList = ["IS_SANDBOX=1", "DISABLE_AUTOUPDATER=1"];
  if (facts.hasGitconfig) envList.push(`GIT_CONFIG_GLOBAL=${containerDir}/gitconfig`);
  // The engine token is not in this list: `writeEngineTokenFile()` puts it in
  // the state directory, out of reach of the environment `docker exec`
  // passes to every session.
  envList.push(
    `${ENGINE_ENV.tokenFile}=${STATE_MOUNT}/${ENGINE_TOKEN_FILE_NAME}`,
    `${ENGINE_ENV.port}=${DEFAULT_ENGINE_PORT}`,
    `${ENGINE_ENV.projectRoot}=${containerDir}`,
    `${ENGINE_ENV.container}=${input.container}`,
    `${ENGINE_ENV.engineVersion}=${input.engine.version}`,
    `${ENGINE_ENV.stateDir}=${STATE_MOUNT}`,
    `${BROKER_ENV.socket}=${BROKER_SOCKET_PATH}`,
  );
  for (const [name, value] of Object.entries(input.extraEnv ?? {})) {
    if (!RESERVED_ENV_NAMES.has(name)) envList.push(`${name}=${value}`);
  }
  // Names only, for the label. A reserved name, stored before the settings
  // refused it, is left out.
  const secretNames = [...new Set(input.secretNames)]
    .filter((n) => !RESERVED_ENV_NAMES.has(n))
    .sort();

  const portBindings: ContainerCreateSpec["portBindings"] = {
    [`${DEFAULT_ENGINE_PORT}/tcp`]: [
      { hostIp: "127.0.0.1", hostPort: String(input.engine.hostPort) },
    ],
  };
  // Loopback unless the map asks for every interface: a published port is
  // otherwise reachable from the network the host is on.
  for (const t of input.tcpMaps) {
    portBindings[`${t.container}/tcp`] = [
      { hostIp: t.allInterfaces ? "" : "127.0.0.1", hostPort: String(t.host) },
    ];
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
      [LABELS.sudo]: sudoLabel(input.sudoPassword ?? false),
      [LABELS.secrets]: SECRETS_LABEL_BROKER,
      // Absent means `host`: a host-mode launch is what it always was.
      ...(input.accounts ? { [LABELS.accountsMode]: "accounts" } : {}),
    },
    capDrop: [...DROPPED_CAPABILITIES],
    tty: true,
    openStdin: true,
    autoRemove: true,
  };
}

/**
 * The `agentbox.tcp-maps` label value, sorted and comma-separated:
 * `127.0.0.1:HOST:CONTAINER` for a loopback map and `HOST:CONTAINER` for one
 * on every interface. Containers created before loopback became the default
 * published every map on all interfaces with the second form, so they show
 * as stale until restarted.
 */
export function tcpMapsLabel(maps: readonly TcpMap[]): string {
  return maps
    .map((t) =>
      t.allInterfaces ? `${t.host}:${t.container}` : `127.0.0.1:${t.host}:${t.container}`,
    )
    .sort()
    .join(",");
}

/**
 * The same spec as a `docker run` command line, for logs, docs, and the host
 * test scripts. Environment values are masked except the fixed ones, so the
 * result is safe to print even for a spec from before the broker.
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
    ENGINE_ENV.tokenFile,
    ENGINE_ENV.port,
    ENGINE_ENV.projectRoot,
    ENGINE_ENV.container,
    ENGINE_ENV.engineVersion,
    ENGINE_ENV.stateDir,
    BROKER_ENV.socket,
  ]);
  const args = ["run", "-d", "-i", "-t"];
  if (spec.autoRemove) args.push("--rm");
  args.push("--name", spec.name, "--user", spec.user);
  for (const cap of spec.capDrop ?? []) args.push("--cap-drop", cap);
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
