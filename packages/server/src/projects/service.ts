// Projects: CRUD, mounts, TCP maps, secret references, the policy path, the
// engine port registry, and the project container (3.3.5 `ProjectRecord`,
// `SharedContainer`, and `DockerBackend::startShared`).
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  DEFAULT_ENGINE_PORT,
  ProjectInputSchema,
  ProjectUpdateSchema,
  hostPathProblem,
  projectContainerName,
  type ContainerInfo,
  type ContainerState,
  type EngineAccountDirs,
  type Platform,
  type Project,
  type ProjectSummary,
  type HostOs,
} from "@aio/contracts";
import type { z } from "zod";
import type { EngineEndpoint, Repositories } from "../db/repositories.js";
import { noEngineMessage, type ImageVersions } from "../docker/image.js";
import {
  LABELS,
  type BrokerLaunch,
  type LaunchInput,
  SECRETS_LABEL_BROKER,
  buildLaunchSpec,
  mergeMounts,
  mountBind,
  mountContainerPaths,
  prepareLaunchHost,
  sudoLabel,
  tcpMapsLabel,
} from "../docker/launch.js";
import { HOME_LINKS_SCRIPT, rootSetupExec, skippedHomeLinks } from "../docker/scripts.js";
import {
  liveSessions,
  mountsFile,
  readMountsFile,
  stateDir,
  accountDirsFile,
  readContainerLayout,
  writeAccountDirsFile,
  writeContainerLayout,
  writeEngineTokenFile,
  writeMountsFile,
} from "../docker/state.js";
import type { ContainerInspect, DockerClient } from "../docker/types.js";
import { boxTmuxSession } from "../records/box.js";
import { readRegularFileSync } from "../records/regular-file.js";
import {
  accountDirFor,
  containerHome,
  homePaths,
  hostOsOf,
  hostToContainer,
  type HostEnv,
} from "../records/env.js";
import { ApiError, notFound } from "../records/errors.js";
import type { CoreEvents } from "../records/events.js";
import type { CoreHooks, EngineHealth } from "../records/hooks.js";
import type { KeyedMutex } from "../records/mutex.js";
import { assertMountable, assertUniqueNames, type SettingsService } from "../records/settings.js";
import { SHA512_CRYPT_PATTERN } from "../secrets/crypt.js";
import { BrokerTransportResolver, type BrokerTransportDecision } from "../secrets/transport.js";
import { defaultProjectName, detectPrimaryRepo, normalizeRoot, projectIdForRoot } from "./ids.js";

export type ProjectUpdate = z.input<typeof ProjectUpdateSchema>;

/** Picks a free loopback port that is not in `exclude`. */
export async function freeLoopbackPort(exclude: ReadonlySet<number>): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        srv.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
      });
    });
    if (port > 0 && !exclude.has(port)) return port;
  }
  throw new Error("Could not find a free loopback port.");
}

/** Whether `port` can be bound on 127.0.0.1 right now. */
export function loopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

export interface ProjectServiceDeps {
  env: HostEnv;
  repos: Repositories;
  docker: DockerClient;
  events: CoreEvents;
  settings: SettingsService;
  hooks: () => CoreHooks;
  prepareAccount: (vendor: Platform, name?: string) => { dir: string; problems: string[] };
  mutex: KeyedMutex;
  imageVersions: ImageVersions;
  /** The engine version this server expects in the image. */
  engineVersion: string;
  /** Picks the engine's host port; tests replace it. */
  allocatePort?: (exclude: ReadonlySet<number>) => Promise<number>;
  /** Whether a stored engine port is still free; tests replace it. */
  portFree?: (port: number) => Promise<boolean>;
  /**
   * Decides the secrets broker transport for a new container. Default: the
   * `brokerTransport` setting resolved against the engine's `/info` and this
   * process's platform; see `decideBrokerTransport()`.
   */
  brokerTransport?: () => Promise<BrokerTransportDecision>;
  /** Seconds the keeper lingers; 30 unless a test shortens it. */
  graceSec?: number;
  /** Milliseconds to wait for a stopped container to go away. */
  removalTimeoutMs?: number;
  /**
   * Logs the broker transport decision and problems that don't stop a
   * container, such as a home link left alone. Default: none.
   */
  log?: (message: string) => void;
}

export interface EnsureContainerResult {
  container: string;
  /** True when this call created the container. */
  created: boolean;
  /** Differences between a reused container and the project; empty when it matches. */
  stale: string[];
}

function containerState(inspect: ContainerInspect | null): ContainerState {
  if (!inspect) return "removed";
  if (inspect.running) return "running";
  return inspect.state === "created" ? "created" : "exited";
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The settings whose change moves a vendor's default account folder. */
const ACCOUNT_DIR_SETTINGS = new Set(["accountDefaults", "accountsMode"]);

export class ProjectService {
  private readonly resolver: BrokerTransportResolver;
  /** The last transport decision, for the stale check; `null` until one is made. */
  private lastBroker: BrokerTransportDecision | null = null;

  constructor(private readonly deps: ProjectServiceDeps) {
    const docker = deps.docker;
    this.resolver = new BrokerTransportResolver({
      info: docker.info ? () => docker.info!() : undefined,
      setting: () => deps.settings.get().brokerTransport,
      dockerHost: process.env.DOCKER_HOST,
      log: deps.log,
    });
    // The engine reads the file for every vendor call, so a running
    // container follows a new default without a restart, within what it mounts.
    deps.events.on("settings.changed", (payload: { changedKeys?: string[] }) => {
      if (payload.changedKeys?.some((k) => ACCOUNT_DIR_SETTINGS.has(k))) this.syncAccountDirs();
    });
  }

  /** The broker transport a container created now gets. */
  async brokerTransport(): Promise<BrokerTransportDecision> {
    const decision = await (this.deps.brokerTransport ?? (() => this.resolver.resolve()))();
    this.lastBroker = decision;
    return decision;
  }

  private get repos() {
    return this.deps.repos;
  }

  private now(): string {
    return this.deps.env.now().toISOString();
  }

  /** The host OS, which decides how host paths map to container paths. */
  private get hostOs(): HostOs {
    return hostOsOf(this.deps.env);
  }

  /** The project for a directory, created implicitly (as 3.3.5 did) when missing. */
  ensureForRoot(rootIn: string): Project {
    const root = normalizeRoot(rootIn, this.hostOs);
    if (root === "") throw new ApiError("validation", "A project needs a directory.");
    const problem = hostPathProblem(root, this.hostOs);
    if (problem)
      throw new ApiError("validation", `The project directory can't be used: ${problem}`);
    const existing = this.repos.projects.byRoot(root);
    if (existing) return existing;
    const now = this.now();
    const project = ProjectInputSchema.parse({
      id: projectIdForRoot(root),
      root,
      name: defaultProjectName(root),
      primaryRepo: detectPrimaryRepo(root),
      createdAt: now,
      updatedAt: now,
    });
    return this.repos.projects.put(project);
  }

  /** `projects.create`: registers an existing directory. */
  create(input: { root: string; name?: string }): Project {
    const root = normalizeRoot(input.root, this.hostOs);
    const problem = hostPathProblem(root, this.hostOs);
    if (problem)
      throw new ApiError("validation", `The project directory can't be used: ${problem}`);
    if (!isDirectory(root)) throw new ApiError("validation", `${input.root} is not a directory.`);
    if (this.repos.projects.byRoot(root)) {
      throw new ApiError("conflict", `${root} is already a project.`);
    }
    const project = this.ensureForRoot(root);
    if (input.name !== undefined && input.name.trim() !== "") {
      return this.repos.projects.put({
        ...project,
        name: input.name.trim(),
        updatedAt: this.now(),
      });
    }
    return project;
  }

  get(id: string): Project {
    return this.repos.projects.get(id) ?? notFound(`The project ${id}`);
  }

  list(): Project[] {
    return this.repos.projects.list();
  }

  containerName(project: Pick<Project, "id">): string {
    return projectContainerName(project.id);
  }

  /** The absolute host path of the project's policy file. */
  policyFile(project: Project): string {
    return path.isAbsolute(project.policyPath)
      ? project.policyPath
      : path.join(project.root, project.policyPath);
  }

  engineEndpoint(projectId: string): EngineEndpoint | undefined {
    return this.repos.engines.get(projectId);
  }

  async containerInfo(project: Project): Promise<ContainerInfo> {
    const name = this.containerName(project);
    const inspect = await this.deps.docker.inspectContainer(name);
    const endpoint = this.repos.engines.get(project.id);
    const health = this.deps.hooks().engineHealth(name);
    // The same check as a project change or a box start makes, so the list
    // and the view flag a container that those would call stale.
    const stale = this.staleFromInspect(project, inspect, await this.currentImageId(inspect));
    return {
      name,
      state: containerState(inspect),
      engine:
        inspect || endpoint
          ? {
              hostPort: endpoint?.hostPort ?? null,
              version: health.version,
              healthy: health.healthy,
              versionMatches: this.versionMatches(health),
            }
          : null,
      ...(stale.length > 0 ? { stale } : {}),
    };
  }

  private versionMatches(health: EngineHealth): boolean | null {
    if (health.versionMatches !== undefined) return health.versionMatches;
    return health.version === null ? null : health.version === this.deps.engineVersion;
  }

  /** A project with its box counts and container, as `projects.list` returns it. */
  async summary(project: Project): Promise<ProjectSummary> {
    const boxes = this.repos.boxes.byProject(project.id);
    const live = new Set(liveSessions(this.deps.env, this.containerName(project)));
    const container: ContainerInfo | null = await this.containerInfo(project).catch(() => null);
    return {
      project,
      running: boxes.filter((b) => live.has(boxTmuxSession(b))).length,
      total: boxes.length,
      container,
    };
  }

  async summaries(): Promise<ProjectSummary[]> {
    const list = this.list().sort((a, b) => a.name.localeCompare(b.name));
    return Promise.all(list.map((p) => this.summary(p)));
  }

  /**
   * `projects.update`. Returns the running boxes that keep the old mounts,
   * ports, or secrets until their container restarts.
   */
  async update(
    id: string,
    input: ProjectUpdate,
  ): Promise<{ project: Project; staleBoxes: string[] }> {
    const parsed = ProjectUpdateSchema.safeParse(input);
    if (!parsed.success)
      throw new ApiError("validation", parsed.error.issues[0]?.message ?? "invalid update");
    const u = parsed.data;
    const project = this.get(id);
    const next: Project = { ...project, updatedAt: this.now() };
    if (u.name !== undefined) next.name = u.name.trim() || defaultProjectName(project.root);
    if (u.primaryRepo !== undefined) {
      if (u.primaryRepo === null) delete next.primaryRepo;
      else if (!isDirectory(u.primaryRepo))
        throw new ApiError("validation", `${u.primaryRepo} is not a directory.`);
      else
        next.primaryRepo =
          this.hostOs === "win32" ? normalizeRoot(u.primaryRepo, this.hostOs) : u.primaryRepo;
    }
    if (u.tcpMaps !== undefined) {
      const hosts = new Set<number>();
      const containers = new Set<number>();
      for (const t of u.tcpMaps) {
        if (t.container === DEFAULT_ENGINE_PORT) {
          throw new ApiError(
            "validation",
            `Container port ${DEFAULT_ENGINE_PORT} belongs to the engine.`,
          );
        }
        if (hosts.has(t.host) || containers.has(t.container)) {
          throw new ApiError("validation", `The TCP map ${t.host}:${t.container} repeats a port.`);
        }
        hosts.add(t.host);
        containers.add(t.container);
      }
      next.tcpMaps = u.tcpMaps;
    }
    if (u.mounts !== undefined) {
      assertMountable(u.mounts, this.hostOs);
      const missing = u.mounts.filter((m) => !isDirectory(m.host)).map((m) => m.host);
      if (missing.length > 0) {
        throw new ApiError(
          "validation",
          `These host directories do not exist: ${missing.join(", ")}.`,
          { missing },
        );
      }
      next.mounts = u.mounts;
    }
    if (u.secretRefs !== undefined) {
      assertUniqueNames(u.secretRefs);
      next.secretRefs = u.secretRefs;
    }
    if (u.ceilingsOverride !== undefined) {
      if (u.ceilingsOverride === null) delete next.ceilingsOverride;
      else next.ceilingsOverride = u.ceilingsOverride;
    }
    if (u.policyPath !== undefined) next.policyPath = u.policyPath;
    const saved = this.repos.projects.put(next);
    const stale = await this.staleDifferences(saved);
    return { project: saved, staleBoxes: stale.length > 0 ? this.runningBoxIds(saved) : [] };
  }

  /** Ids of the project's boxes whose session is live. */
  runningBoxIds(project: Project): string[] {
    const live = new Set(liveSessions(this.deps.env, this.containerName(project)));
    return this.repos.boxes
      .byProject(project.id)
      .filter((b) => live.has(boxTmuxSession(b)))
      .map((b) => b.id);
  }

  /** The mounts the container gets: the project's, then the global ones it does not shadow. */
  wantedBinds(project: Project): string[] {
    return mergeMounts(project.mounts, this.deps.settings.get().globalMounts).map((m) =>
      mountBind(m, this.hostOs),
    );
  }

  /**
   * How a running project container differs from what the project asks for:
   * mounts (compared with the recorded `mounts` file, else the container's
   * binds), TCP maps, the sudo policy, and whether secrets come from the
   * broker, and the image when the configured tag names a rebuilt one. The
   * secret names don't count: the broker reads them on every request. Empty
   * when the container is not running or matches.
   */
  async staleDifferences(project: Project): Promise<string[]> {
    const inspect = await this.deps.docker.inspectContainer(this.containerName(project));
    if (inspect?.running) await this.brokerTransport().catch(() => undefined);
    return this.staleFromInspect(project, inspect, await this.currentImageId(inspect));
  }

  /**
   * The id of the image the configured tag names now, for a running
   * container only. `undefined` when the image can't be inspected, which
   * then flags nothing.
   */
  private async currentImageId(inspect: ContainerInspect | null): Promise<string | undefined> {
    if (!inspect?.running) return undefined;
    const image = this.deps.settings.get().engineImage;
    const info = await this.deps.docker.inspectImage(image).catch(() => null);
    return info?.id;
  }

  /**
   * `staleDifferences` for a container already inspected. `imageId` is the
   * configured image's id, from `currentImageId`.
   */
  private staleFromInspect(
    project: Project,
    inspect: ContainerInspect | null,
    imageId: string | undefined,
  ): string[] {
    const name = this.containerName(project);
    if (!inspect?.running) return [];
    const wanted = this.wantedBinds(project);
    const diffs: string[] = [];
    const had = readMountsFile(this.deps.env, name);
    if (had) {
      for (const d of wanted) if (!had.includes(d)) diffs.push(d);
      for (const d of had) if (!wanted.includes(d)) diffs.push(`${d} (removed)`);
    } else {
      for (const d of wanted) if (!inspect.binds.includes(d)) diffs.push(d);
    }
    // A container made before the mode changed mounts the other layout.
    const haveMode = inspect.labels[LABELS.accountsMode] ?? "host";
    const wantMode = "accounts";
    if (haveMode !== wantMode) diffs.push(`accounts mode ${haveMode} -> ${wantMode}`);
    const haveMaps = inspect.labels[LABELS.tcpMaps] ?? "";
    const wantMaps = tcpMapsLabel(project.tcpMaps);
    if (haveMaps !== wantMaps)
      diffs.push(`TCP maps ${haveMaps || "none"} -> ${wantMaps || "none"}`);
    // A container from before the broker holds its secret values in its
    // environment, where `docker inspect` shows them.
    if (inspect.labels[LABELS.secrets] !== SECRETS_LABEL_BROKER)
      diffs.push("secrets environment -> broker");
    // The broker transport is fixed in the container's environment. Absent
    // means the Unix socket, so nothing changes for a native Linux engine.
    else if (this.lastBroker) {
      const haveBroker = inspect.labels[LABELS.brokerTransport] ?? "unix";
      if (haveBroker !== this.lastBroker.transport)
        diffs.push(`broker ${haveBroker} -> ${this.lastBroker.transport}`);
    }
    // A container from before the label has the old image's passwordless sudo.
    const haveSudo = inspect.labels[LABELS.sudo] ?? "passwordless";
    const wantSudo = sudoLabel(this.deps.settings.get().sudoPasswordRef !== undefined);
    if (haveSudo !== wantSudo) diffs.push(`sudo ${haveSudo} -> ${wantSudo}`);
    // Every engine reports the same development version, so only the image
    // id shows a container that runs an image from before a rebuild.
    if (imageId !== undefined && inspect.imageId !== imageId) diffs.push("image -> rebuilt");
    return diffs;
  }

  /**
   * The accounts part of every launch: the Claude account folders, whose
   * `sessions` folders get this
   * container's own directory.
   */
  private accountsLaunch(): LaunchInput["accounts"] {
    return {
      claudeDirs: this.repos.accounts
        .list()
        .filter((a) => a.vendor === "claude")
        .map((a) => accountDirFor(this.deps.env, "claude", a.name)),
    };
  }

  /**
   * The default account folder of each vendor as the container sees it, or
   * an empty object in `host` mode. A vendor without a default has no entry.
   */
  accountDirs(): EngineAccountDirs {
    const settings = this.deps.settings.get();
    if (settings.accountsMode !== "accounts") return {};
    const out: EngineAccountDirs = {};
    for (const vendor of ["claude", "codex", "copilot"] as const satisfies Platform[]) {
      const id = settings.accountDefaults[vendor];
      if (id === undefined || !id.startsWith(`${vendor}/`)) continue;
      out[vendor] = hostToContainer(
        accountDirFor(this.deps.env, vendor, id.slice(vendor.length + 1)),
        this.hostOs,
      );
    }
    return out;
  }

  /**
   * The account folders one container can use: the current defaults, limited
   * to what it mounts. A container launched in host mode doesn't mount the
   * accounts folder, so it stays on its home folders. An account made after
   * the launch has no `sessions` mount there, so Claude stays on its previous
   * folder until the container restarts.
   */
  private containerAccountDirs(container: string): EngineAccountDirs {
    const wanted = this.accountDirs();
    const layout = readContainerLayout(this.deps.env, container);
    if (!layout) return wanted;
    if (!layout.accounts) return {};
    if (wanted.claude === undefined || layout.claudeDirs.includes(wanted.claude)) return wanted;
    this.deps.log?.(
      `${container}: the default Claude account has no mount in this container, so review ` +
        `runs keep the previous account until the container restarts.`,
    );
    const { claude: _claude, ...others } = wanted;
    const previous = readRegularFileSync(accountDirsFile(this.deps.env, container));
    const kept = previous === null ? undefined : (JSON.parse(previous) as EngineAccountDirs).claude;
    return kept === undefined ? others : { ...others, claude: kept };
  }

  /** Brings one container's account folders file up to date. Logs a failure. */
  private syncContainerAccountDirs(container: string): void {
    try {
      const dirs = this.containerAccountDirs(container);
      writeAccountDirsFile(this.deps.env, container, dirs);
      const layout = readContainerLayout(this.deps.env, container);
      if (layout?.accounts) {
        void this.linkHome(container, container, layout.accountLinkTargets, dirs).catch(
          () => undefined,
        );
      }
    } catch (err) {
      this.deps.log?.(
        `Couldn't update the account folders for ${container}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Rewrites the account folders file (`account-dirs.json`) of every
   * container that has an engine record and a state directory, and moves its
   * home links, so its engine and shells use the current defaults. A failure
   * is logged, not thrown: the settings change itself succeeded.
   */
  syncAccountDirs(): void {
    try {
      for (const { container } of this.repos.engines.list()) {
        if (isDirectory(stateDir(this.deps.env, container))) {
          this.syncContainerAccountDirs(container);
        }
      }
    } catch (err) {
      this.deps.log?.(`Couldn't update the account folders: ${(err as Error).message}`);
    }
  }

  /**
   * Links the container user's home to the default account of each vendor:
   * `~/.claude`, `~/.claude.json`, `~/.codex`, and `~/.copilot`. Keeps a bare
   * `claude` in a shell working and keeps absolute paths in user files, such
   * as the global `CLAUDE.md`, resolving. Failures don't stop the start:
   * the sessions name their account's folder themselves, and the engine
   * takes it from `account-dirs.json`. A link the script left alone is
   * logged.
   */
  private async linkHome(
    container: string,
    name: string,
    accountLinkTargets: readonly string[],
    dirs: EngineAccountDirs = this.accountDirs(),
  ): Promise<void> {
    const home = containerHome(this.deps.env);
    const args: string[] = [];
    if (dirs.claude !== undefined)
      args.push(
        dirs.claude,
        `${home}/.claude`,
        `${dirs.claude}/.claude.json`,
        `${home}/.claude.json`,
      );
    if (dirs.codex !== undefined) args.push(dirs.codex, `${home}/.codex`);
    if (dirs.copilot !== undefined) args.push(dirs.copilot, `${home}/.copilot`);
    if (args.length === 0) return;
    const result = await this.deps.docker
      .exec(container, {
        cmd: ["/bin/sh", "-c", HOME_LINKS_SCRIPT, "_", ...args],
        user: this.deps.env.user,
        timeoutMs: 15_000,
      })
      .catch(() => undefined);
    for (const link of skippedHomeLinks(result?.stdout ?? "")) {
      this.deps.log?.(skippedLinkMessage(name, link, accountLinkTargets));
    }
  }

  /** Checks the engine image: it must exist and carry the expected engine version. */
  async checkImage(): Promise<{ image: string; imageId: string }> {
    const image = this.deps.settings.get().engineImage;
    const info = await this.deps.docker.inspectImage(image);
    if (!info) {
      throw new ApiError("image_missing", `The image ${image} does not exist. Build it first.`, {
        image,
      });
    }
    const read = await this.deps.imageVersions.read(image);
    const have = read?.versions.engineVersion ?? null;
    if (have !== this.deps.engineVersion) {
      throw new ApiError(
        "engine_mismatch",
        have === null
          ? noEngineMessage(image)
          : `The image ${image} carries engine ${have}, but this server needs ${this.deps.engineVersion}. Rebuild the image.`,
        { image, imageEngineVersion: have, expected: this.deps.engineVersion },
      );
    }
    return { image, imageId: info.id };
  }

  /**
   * Polls until the container is gone, removing it once it has stopped;
   * returns whether it went. A stopped auto-remove container may still be
   * on its way out, so the name is free only once inspect finds nothing.
   */
  async waitForRemoval(container: string): Promise<boolean> {
    const deadline = Date.now() + (this.deps.removalTimeoutMs ?? 5000);
    let removeAsked = false;
    for (;;) {
      const inspect = await this.deps.docker.inspectContainer(container);
      if (!inspect) return true;
      if (!inspect.running && !removeAsked) {
        await this.deps.docker.removeContainer(container, { force: true });
        removeAsked = true;
        continue;
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Stops the project container and waits until it is gone. */
  async stopContainer(projectId: string): Promise<void> {
    const name = projectContainerName(projectId);
    await this.deps.docker.stopContainer(name, 10);
    await this.waitForRemoval(name);
    this.publishContainer(projectId, name, "removed");
  }

  private publishContainer(projectId: string, container: string, state: ContainerState): void {
    const endpoint = this.repos.engines.get(projectId);
    const health = this.deps.hooks().engineHealth(container);
    this.deps.events.publish({
      type: "container.changed",
      container,
      projectId,
      state,
      engine:
        state === "removed"
          ? null
          : {
              hostPort: endpoint?.hostPort ?? null,
              version: health.version,
              healthy: health.healthy,
              versionMatches: this.versionMatches(health),
            },
    });
  }

  /**
   * The host port of the container's TCP broker: the stored one when no
   * other project uses it and it is free or the broker already holds it for
   * this container, else a new one. Never an engine port.
   */
  private async brokerPort(projectId: string, container: string): Promise<number> {
    const taken = new Set<number>();
    for (const e of this.repos.engines.list()) {
      taken.add(e.hostPort);
      if (e.projectId !== projectId && e.brokerPort !== undefined) taken.add(e.brokerPort);
    }
    const stored = this.repos.engines.get(projectId)?.brokerPort;
    const portFree = this.deps.portFree ?? loopbackPortFree;
    if (stored !== undefined && !taken.has(stored)) {
      if (this.deps.hooks().brokerTcpPort?.(container) === stored) return stored;
      if (await portFree(stored)) return stored;
    }
    return (this.deps.allocatePort ?? freeLoopbackPort)(taken);
  }

  /** Reuses the stored engine port when it is still free, else picks a new one. */
  private async enginePort(projectId: string): Promise<number> {
    const others = new Set(
      this.repos.engines
        .list()
        .filter((e) => e.projectId !== projectId)
        .map((e) => e.hostPort),
    );
    const stored = this.repos.engines.get(projectId)?.hostPort;
    const portFree = this.deps.portFree ?? loopbackPortFree;
    if (stored !== undefined && !others.has(stored) && (await portFree(stored))) return stored;
    return (this.deps.allocatePort ?? freeLoopbackPort)(others);
  }

  /**
   * Runs the root setup step (`ROOT_SETUP_SCRIPT`) in a container that just
   * started: `docker exec --user root`, never sudo. The hash travels on
   * standard input, so it is in no command line, environment, or inspect
   * output. Throws when the step fails, because the container's sudo
   * policy is then unknown and an older image's passwordless rule may
   * still be in place.
   */
  private async runRootSetup(
    container: string,
    project: Project,
    passwordHash: string | null,
  ): Promise<void> {
    const exec = rootSetupExec(
      this.deps.env.user,
      containerHome(this.deps.env),
      mountContainerPaths(
        {
          root: project.root,
          mounts: project.mounts,
          globalMounts: this.deps.settings.get().globalMounts,
        },
        this.accountsLaunch() ? homePaths(this.deps.env).accountsDir : undefined,
        this.hostOs,
      ),
      passwordHash,
    );
    const r = await this.deps.docker.exec(container, { ...exec, timeoutMs: 60_000 });
    if (r.exitCode !== 0) {
      const reason = r.stderr.trim().slice(0, 300) || `exit code ${r.exitCode ?? "unknown"}`;
      throw new ApiError(
        "internal",
        `The container's sudo setup failed, so the container was removed: ${reason}`,
      );
    }
  }

  /**
   * Makes sure the project container runs (3.3.5 `startShared` minus the
   * session): checks the image, replaces an idle container whose mounts went
   * stale or whose image was rebuilt, and creates one when none runs.
   * `options.extraEnv` is for the host test scripts: plain variables, never
   * secrets.
   */
  async ensureContainer(
    projectId: string,
    options: { extraEnv?: Record<string, string> } = {},
  ): Promise<EnsureContainerResult> {
    if (this.deps.settings.get().accountsMode !== "accounts")
      throw new ApiError(
        "conflict",
        'Host mode is no longer supported. Set up accounts and run "aio accounts relink" before starting containers.',
      );
    for (const vendor of ["codex", "copilot"] as const) {
      const id = this.deps.settings.get().accountDefaults[vendor];
      if (!id) continue;
      const prepared = this.deps.prepareAccount(vendor, id.slice(vendor.length + 1));
      for (const problem of prepared.problems) this.deps.log?.(`${id}: ${problem}`);
    }
    return this.deps.mutex.run(projectId, async () => {
      const project = this.get(projectId);
      const { image, imageId } = await this.checkImage();
      const name = this.containerName(project);
      const docker = this.deps.docker;

      const inspect = await docker.inspectContainer(name);
      if (inspect?.running) {
        const stale = await this.staleDifferences(project);
        const idle = liveSessions(this.deps.env, name).length === 0;
        if (idle && (stale.length > 0 || inspect.imageId !== imageId)) {
          await docker.stopContainer(name, 10);
          await this.waitForRemoval(name);
        } else {
          // Covers a container from an older server, and a missed settings event.
          this.syncContainerAccountDirs(name);
          return { container: name, created: false, stale };
        }
      } else if (inspect) {
        // Exited but not removed, as after a daemon restart, or an idle
        // container the daemon is removing right now: clear it away.
        if (!(await this.waitForRemoval(name))) {
          throw new ApiError(
            "conflict",
            `The container ${name} is still being removed. Try again.`,
          );
        }
      }

      // The pre-start check: every reference must resolve now, so a locked
      // 1Password blocks the launch instead of failing later inside a tool.
      // It also opens the broker socket that the container asks for values,
      // or under Docker Desktop, the broker's TCP listener and a new token.
      const decision = await this.brokerTransport();
      let broker: BrokerLaunch = { transport: "unix" };
      let secretNames: string[];
      if (decision.transport === "tcp") {
        const port = await this.brokerPort(projectId, name);
        broker = { transport: "tcp", port, hostGateway: decision.hostGateway };
        secretNames = await this.deps.hooks().prepareSecrets(projectId, name, {
          transport: "tcp",
          port,
        });
      } else {
        secretNames = await this.deps.hooks().prepareSecrets(projectId, name);
      }
      // So is the sudo password: only its hash reaches the container.
      const passwordHash = await this.deps.hooks().sudoPasswordHash();
      if (passwordHash !== null && !SHA512_CRYPT_PATTERN.test(passwordHash)) {
        throw new ApiError("internal", "The sudo password hash is not a SHA-512 crypt hash.");
      }
      const hostPort = await this.enginePort(projectId);
      const token = crypto.randomBytes(32).toString("hex");
      const accounts = this.accountsLaunch();
      const facts = prepareLaunchHost(this.deps.env, {
        container: name,
        root: project.root,
        accounts,
      });
      const spec = buildLaunchSpec(
        this.deps.env,
        {
          container: name,
          projectId,
          root: project.root,
          mounts: project.mounts,
          globalMounts: this.deps.settings.get().globalMounts,
          tcpMaps: project.tcpMaps,
          image,
          engine: { hostPort, token, version: this.deps.engineVersion },
          secretNames,
          extraEnv: options.extraEnv,
          graceSec: this.deps.graceSec,
          sudoPassword: passwordHash !== null,
          accounts,
          // Absent for the Unix socket, so that launch is what it always was.
          ...(broker.transport === "tcp" ? { broker } : {}),
        },
        facts,
      );
      writeEngineTokenFile(this.deps.env, name, token);
      // A failed write must not block the start: the engine warns and falls
      // back to the home folders.
      try {
        writeContainerLayout(this.deps.env, name, {
          accounts: accounts !== undefined && accounts !== null,
          claudeDirs: (accounts?.claudeDirs ?? []).map((dir) => hostToContainer(dir, this.hostOs)),
          accountLinkTargets: facts.accountLinkTargets ?? [],
        });
        writeAccountDirsFile(this.deps.env, name, this.accountDirs());
      } catch (err) {
        this.deps.log?.(
          `Couldn't write the account folders for ${name}: ${(err as Error).message}`,
        );
      }
      const id = await docker.createContainer(spec);
      try {
        await docker.startContainer(id);
        await this.runRootSetup(id, project, passwordHash);
        if (accounts) await this.linkHome(id, name, facts.accountLinkTargets ?? []);
      } catch (err) {
        await docker.removeContainer(id, { force: true }).catch(() => undefined);
        throw err;
      }
      // The container runs: losing the mounts record only costs a stale
      // check against the container's binds, so it must not lose the engine
      // record below.
      try {
        writeMountsFile(this.deps.env, name, this.wantedBinds(project));
      } catch {
        // Without the file, staleDifferences() compares the container's binds.
        fs.rmSync(mountsFile(this.deps.env, name), { recursive: true, force: true });
      }
      this.repos.engines.put(
        {
          projectId,
          container: name,
          hostPort,
          token,
          ...(broker.transport === "tcp" ? { brokerPort: broker.port } : {}),
        },
        this.deps.env.now(),
      );
      // A settings change during the start skipped this container, which had no record yet.
      try {
        writeAccountDirsFile(this.deps.env, name, this.containerAccountDirs(name));
      } catch (err) {
        this.deps.log?.(
          `Couldn't update the account folders for ${name}: ${(err as Error).message}`,
        );
      }
      this.publishContainer(projectId, name, "running");
      return { container: name, created: true, stale: [] };
    });
  }
}

/**
 * The warning for a home link that `HOME_LINKS_SCRIPT` left alone. When the
 * link is a folder that holds the mount points of account links that lead
 * outside the account folder, such as `~/.claude/CLAUDE.md` linked to the
 * host's own file, Docker made that folder to hold the mounts. Shell use of
 * a bare `claude` then sees no sign-in; boxes and the engine aren't
 * affected, since they name the account folder themselves.
 */
export function skippedLinkMessage(
  container: string,
  link: string,
  accountLinkTargets: readonly string[],
): string {
  const inside = accountLinkTargets.filter((t) => t === link || t.startsWith(`${link}/`));
  if (inside.length > 0) {
    return (
      `${container}: ${link} is a folder, not a link to the default account, because ` +
      `Docker created it to hold the mounts of account links that lead outside the ` +
      `account folder (${inside.join(", ")}). A bare command in a container shell ` +
      `doesn't see the account's sign-in there; boxes and review runs name the ` +
      `account folder themselves.`
    );
  }
  return (
    `${container}: ${link} already exists and isn't a link, so it wasn't linked to the ` +
    `default account. A bare command in a container shell uses it instead of the account.`
  );
}
