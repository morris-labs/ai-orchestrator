// The composition root of the server core. `createServerCore()` builds the
// core modules over one database and Docker client. `createCore()` wraps that
// in the `Core` interface the API serves (`src/api/core-interface.ts`), wires
// the server's services in as hooks, and starts polling. The core never
// listens on a port itself.
import fs from "node:fs";
import type { ImageStatus, Platform } from "@agentbox/contracts";
import { apiCoreOf, relayEvents, wireHooks } from "./api/core-adapter.js";
import type { Core as ApiCore, CoreFactoryOptions } from "./api/core-interface.js";
import { BoxService } from "./boxes/service.js";
import { ContainerMonitor } from "./boxes/monitor.js";
import * as conversations from "./catalog/conversations.js";
import { ModelCatalog } from "./catalog/models.js";
import { projectDirFor, transcriptPath } from "./catalog/paths.js";
import { openDatabase, repositories, type Repositories } from "./db/index.js";
import { DockerodeClient } from "./docker/dockerode.js";
import { ImageVersions, imageStatus } from "./docker/image.js";
import type { DockerClient } from "./docker/types.js";
import { needsImport, runImport, type ImportReport } from "./import/importer.js";
import { ProjectService } from "./projects/service.js";
import { defaultHostEnv, homePaths, type HostEnv } from "./records/env.js";
import { CoreEvents } from "./records/events.js";
import { defaultHooks, type CoreHooks } from "./records/hooks.js";
import { KeyedMutex } from "./records/mutex.js";
import { SettingsService } from "./records/settings.js";
import { SshRemoteService } from "./records/sshRemotes.js";
import { removeUnusedBrokerDirs } from "./secrets/broker-dirs.js";
import { SessionWatcher } from "./watcher/sessionWatcher.js";
import * as worktrees from "./worktrees/index.js";

export interface CoreOptions {
  /** The engine version this server expects in the image (`/etc/agentbox-engine-version`). */
  engineVersion: string;
  /** Home directory, container user, and clock. Default: this process's. */
  env?: HostEnv;
  /** The SQLite file, or `":memory:"`. Default: `agentbox.db` in the data directory. */
  dbPath?: string;
  /** Default: dockerode on the local socket (`DOCKER_HOST` honored). */
  docker?: DockerClient;
  /** Seconds a project container lingers with no sessions. Default 30. */
  graceSec?: number;
  /** Picks the engine's host port; tests replace it. */
  allocatePort?: (exclude: ReadonlySet<number>) => Promise<number>;
  /** Whether a stored engine port is free; tests replace it. */
  portFree?: (port: number) => Promise<boolean>;
  /** Milliseconds to wait for a stopped container or session to go away. */
  removalTimeoutMs?: number;
  sessionGoneTimeoutMs?: number;
}

export interface CoreStartOptions {
  /** Imports the 3.3.5 records once when the database has none. Default true. */
  importLegacy?: boolean;
  /** Milliseconds between polls of Docker. Default 3000; 0 turns polling off. */
  pollMs?: number;
  /** Starts the session watcher. Default true. */
  watch?: boolean;
}

/** The image route the core serves; `SetupService` runs builds as `docker build` jobs. */
export interface ImageApi {
  status(): Promise<ImageStatus>;
}

export interface ServerCore {
  readonly env: HostEnv;
  readonly db: Repositories;
  readonly docker: DockerClient;
  readonly events: CoreEvents;
  readonly settings: SettingsService;
  readonly projects: ProjectService;
  readonly boxes: BoxService;
  readonly sshRemotes: SshRemoteService;
  readonly worktrees: typeof worktrees;
  readonly catalog: {
    conversations: (dir: string) => ReturnType<BoxService["conversations"]>;
    titleForUuid: (workDir: string, uuid: string) => Promise<string>;
    projectDirFor: (workDir: string) => string;
    transcriptPath: (workDir: string, uuid: string) => string;
  };
  readonly watcher: SessionWatcher;
  readonly models: ModelCatalog;
  readonly monitor: ContainerMonitor;
  readonly image: ImageApi;
  readonly legacyImport: {
    needed(): boolean;
    run(force?: boolean, dryRun?: boolean): ImportReport;
  };
  /** The engine version this server expects. */
  readonly engineVersion: string;
  hooks(): CoreHooks;
  /** Replaces some or all of the hooks; `createCore()` wires the server's services in. */
  setHooks(hooks: Partial<CoreHooks>): void;
  /** Seeds settings, runs the one-time import, and starts polling and watching. */
  start(options?: CoreStartOptions): Promise<{ imported: ImportReport | null }>;
  /** Stops polling and watching and closes the database. */
  close(): void;
}

export function createServerCore(options: CoreOptions): ServerCore {
  const env = options.env ?? defaultHostEnv();
  const dbPath = options.dbPath ?? homePaths(env).database;
  const db = repositories(openDatabase(dbPath));
  const docker = options.docker ?? new DockerodeClient();
  const events = new CoreEvents();
  const settings = new SettingsService(env, db.settings, events);
  let hooks: CoreHooks = defaultHooks();
  const getHooks = () => hooks;
  const imageVersions = new ImageVersions(docker);
  const projects = new ProjectService({
    env,
    repos: db,
    docker,
    events,
    settings,
    hooks: getHooks,
    mutex: new KeyedMutex(),
    imageVersions,
    engineVersion: options.engineVersion,
    allocatePort: options.allocatePort,
    portFree: options.portFree,
    graceSec: options.graceSec,
    removalTimeoutMs: options.removalTimeoutMs,
  });
  const boxes = new BoxService({
    env,
    repos: db,
    docker,
    events,
    settings,
    projects,
    hooks: getHooks,
    sessionGoneTimeoutMs: options.sessionGoneTimeoutMs,
  });
  const watcher = new SessionWatcher({ env, boxes: db.boxes, events });
  const monitor = new ContainerMonitor({
    repos: db,
    docker,
    events,
    boxes,
    onRunning: (ids) => watcher.setRunning(ids),
    now: () => env.now().getTime(),
  });
  const models = new ModelCatalog({
    env,
    docker,
    image: () => settings.get().engineImage,
    getCache: () => settings.get().modelCache,
    setCache: (cache) => {
      settings.setModelCache(cache);
    },
  });
  const image: ImageApi = {
    status: () =>
      imageStatus(imageVersions, docker, settings.get().engineImage, options.engineVersion),
  };

  const core: ServerCore = {
    env,
    db,
    docker,
    events,
    settings,
    projects,
    boxes,
    sshRemotes: new SshRemoteService(env, db),
    worktrees,
    catalog: {
      conversations: (dir) => boxes.conversations(dir),
      titleForUuid: (workDir, uuid) => conversations.titleForUuid(env, workDir, uuid),
      projectDirFor: (workDir) => projectDirFor(env, workDir),
      transcriptPath: (workDir, uuid) => transcriptPath(env, workDir, uuid),
    },
    watcher,
    models,
    monitor,
    image,
    legacyImport: {
      needed: () => needsImport(env, db),
      run: (force = false, dryRun = false) => runImport({ env, repos: db, force, dryRun }),
    },
    engineVersion: options.engineVersion,
    hooks: getHooks,
    setHooks(partial) {
      hooks = { ...hooks, ...partial };
    },
    async start(startOptions = {}) {
      fs.mkdirSync(homePaths(env).dataDir, { recursive: true });
      settings.seedFromConfigFile();
      let imported: ImportReport | null = null;
      if ((startOptions.importLegacy ?? true) && needsImport(env, db)) {
        imported = runImport({ env, repos: db });
      }
      if (startOptions.watch ?? true) watcher.start();
      const pollMs = startOptions.pollMs ?? 3000;
      if (pollMs > 0) monitor.start(pollMs);
      void models.refreshIfStale().catch(() => false);
      return { imported };
    },
    close() {
      monitor.stop();
      watcher.stop();
      db.close();
    },
  };
  return core;
}

/**
 * Builds the API's `Core` over the core modules: opens the database under
 * `home`, connects to Docker on its local socket, installs the server's
 * services as hooks, relays the core's events, and starts the import,
 * polling, and the session watcher. A Docker daemon that does not answer is
 * logged and polled again; the server starts anyway.
 */
export async function createCore(
  options: CoreFactoryOptions & {
    /** Replaces the Docker client; tests pass the in-memory double. */
    docker?: DockerClient;
    start?: CoreStartOptions;
  },
): Promise<ApiCore & { server: ServerCore; close(): Promise<void> }> {
  const log = options.log ?? ((m: string) => console.error(m));
  const dockerode = new DockerodeClient();
  const env: HostEnv = { ...defaultHostEnv(), home: options.home, dataDir: options.dataDir };
  const server = createServerCore({
    engineVersion: options.engineVersion,
    env,
    docker: options.docker ?? dockerode,
  });
  wireHooks(server, options.services);
  const stopRelay = relayEvents(server, options.services);
  try {
    if (!(await server.docker.ping())) {
      log("Docker is unreachable. Box actions fail until the daemon answers; polling continues.");
    } else {
      // Before the API listens, so no container start opens a directory meanwhile.
      try {
        const removed = await removeUnusedBrokerDirs(env, server.docker);
        if (removed.length > 0) {
          log(
            `Removed ${removed.length} unused secrets broker director${removed.length === 1 ? "y" : "ies"}: ${removed.join(", ")}.`,
          );
        }
      } catch (err) {
        log(`Couldn't remove unused secrets broker directories: ${(err as Error).message}`);
      }
    }
    const { imported } = await server.start(options.start);
    if (imported) {
      log(
        `Imported ${imported.projects.imported.length} project(s) and ${imported.boxes.imported.length} box(es) from ${imported.source}.`,
      );
    }
  } catch (err) {
    stopRelay();
    server.close();
    throw err;
  }
  return {
    ...apiCoreOf(server, dockerode.docker),
    server,
    async close() {
      stopRelay();
      server.close();
    },
  };
}

export type { Platform };
export * from "./records/index.js";
export * from "./db/index.js";
export * from "./docker/index.js";
export * from "./projects/index.js";
export * from "./boxes/index.js";
export * from "./catalog/index.js";
export * from "./watcher/index.js";
export * from "./import/index.js";
export { worktrees };
