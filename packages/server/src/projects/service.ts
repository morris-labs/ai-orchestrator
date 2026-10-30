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
  type Project,
  type ProjectSummary,
} from "@agentbox/contracts";
import type { z } from "zod";
import type { EngineEndpoint, Repositories } from "../db/repositories.js";
import type { ImageVersions } from "../docker/image.js";
import {
  LABELS,
  SECRETS_LABEL_BROKER,
  buildLaunchSpec,
  mergeMounts,
  mountBind,
  mountContainerPaths,
  prepareLaunchHost,
  sudoLabel,
  tcpMapsLabel,
} from "../docker/launch.js";
import { rootSetupExec } from "../docker/scripts.js";
import {
  liveSessions,
  mountsFile,
  readMountsFile,
  writeEngineTokenFile,
  writeMountsFile,
} from "../docker/state.js";
import type { ContainerInspect, DockerClient } from "../docker/types.js";
import { boxTmuxSession } from "../records/box.js";
import { containerHome, type HostEnv } from "../records/env.js";
import { ApiError, notFound } from "../records/errors.js";
import type { CoreEvents } from "../records/events.js";
import type { CoreHooks, EngineHealth } from "../records/hooks.js";
import type { KeyedMutex } from "../records/mutex.js";
import { assertMountable, assertUniqueNames, type SettingsService } from "../records/settings.js";
import { SHA512_CRYPT_PATTERN } from "../secrets/crypt.js";
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
  mutex: KeyedMutex;
  imageVersions: ImageVersions;
  /** The engine version this server expects in the image. */
  engineVersion: string;
  /** Picks the engine's host port; tests replace it. */
  allocatePort?: (exclude: ReadonlySet<number>) => Promise<number>;
  /** Whether a stored engine port is still free; tests replace it. */
  portFree?: (port: number) => Promise<boolean>;
  /** Seconds the keeper lingers; 30 unless a test shortens it. */
  graceSec?: number;
  /** Milliseconds to wait for a stopped container to go away. */
  removalTimeoutMs?: number;
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

export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  private get repos() {
    return this.deps.repos;
  }

  private now(): string {
    return this.deps.env.now().toISOString();
  }

  /** The project for a directory, created implicitly (as 3.3.5 did) when missing. */
  ensureForRoot(rootIn: string): Project {
    const root = normalizeRoot(rootIn);
    if (root === "") throw new ApiError("validation", "A project needs a directory.");
    const problem = hostPathProblem(root);
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
    const root = normalizeRoot(input.root);
    const problem = hostPathProblem(root);
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
    const stale = this.staleFromInspect(project, inspect);
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
      else next.primaryRepo = u.primaryRepo;
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
      assertMountable(u.mounts);
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
    return mergeMounts(project.mounts, this.deps.settings.get().globalMounts).map(mountBind);
  }

  /**
   * How a running project container differs from what the project asks for:
   * mounts (compared with the recorded `mounts` file, else the container's
   * binds), TCP maps, the sudo policy, and whether secrets come from the
   * broker. The secret names don't count: the broker reads them on every
   * request. Empty when the container is not running or matches.
   */
  async staleDifferences(project: Project): Promise<string[]> {
    const inspect = await this.deps.docker.inspectContainer(this.containerName(project));
    return this.staleFromInspect(project, inspect);
  }

  /** `staleDifferences` for a container already inspected. */
  private staleFromInspect(project: Project, inspect: ContainerInspect | null): string[] {
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
    const haveMaps = inspect.labels[LABELS.tcpMaps] ?? "";
    const wantMaps = tcpMapsLabel(project.tcpMaps);
    if (haveMaps !== wantMaps)
      diffs.push(`TCP maps ${haveMaps || "none"} -> ${wantMaps || "none"}`);
    // A container from before the broker holds its secret values in its
    // environment, where `docker inspect` shows them.
    if (inspect.labels[LABELS.secrets] !== SECRETS_LABEL_BROKER)
      diffs.push("secrets environment -> broker");
    // A container from before the label has the old image's passwordless sudo.
    const haveSudo = inspect.labels[LABELS.sudo] ?? "passwordless";
    const wantSudo = sudoLabel(this.deps.settings.get().sudoPasswordRef !== undefined);
    if (haveSudo !== wantSudo) diffs.push(`sudo ${haveSudo} -> ${wantSudo}`);
    return diffs;
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
        `The image ${image} carries engine ${have ?? "(none)"}, but this server needs ${this.deps.engineVersion}. Rebuild the image.`,
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
      mountContainerPaths({
        root: project.root,
        mounts: project.mounts,
        globalMounts: this.deps.settings.get().globalMounts,
      }),
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
      // It also opens the broker socket that the container asks for values.
      const secretNames = await this.deps.hooks().prepareSecrets(projectId, name);
      // So is the sudo password: only its hash reaches the container.
      const passwordHash = await this.deps.hooks().sudoPasswordHash();
      if (passwordHash !== null && !SHA512_CRYPT_PATTERN.test(passwordHash)) {
        throw new ApiError("internal", "The sudo password hash is not a SHA-512 crypt hash.");
      }
      const hostPort = await this.enginePort(projectId);
      const token = crypto.randomBytes(32).toString("hex");
      const facts = prepareLaunchHost(this.deps.env, { container: name, root: project.root });
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
        },
        facts,
      );
      writeEngineTokenFile(this.deps.env, name, token);
      const id = await docker.createContainer(spec);
      try {
        await docker.startContainer(id);
        await this.runRootSetup(id, project, passwordHash);
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
      this.repos.engines.put({ projectId, container: name, hostPort, token }, this.deps.env.now());
      this.publishContainer(projectId, name, "running");
      return { container: name, created: true, stale: [] };
    });
  }
}
