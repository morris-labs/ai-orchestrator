// Builds the whole server from a core: the event hub and its listeners, the
// engine supervisor, the scheduler, the HTTPS API server, and the plain HTTP
// listener of the dev-server proxy.
import { writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  BROKER_SOCKET_NAME,
  HOME_PATHS,
  proxyPortOf,
  type AioEvent,
  type Box,
  type Listener,
} from "@aio/contracts";
import type { Core, CoreFactory, CoreServices, EngineEndpoint } from "./core-interface.js";
import type { ApiDeps } from "./deps.js";
import { createApiServer, type ApiServer } from "./server.js";
import { loadOrCreateToken } from "./auth.js";
import { loadOrCreateTlsIdentity } from "./tls.js";
import { assertDevEnginesAllowed, withDevEngines } from "../events/dev-engines.js";
import { EngineSupervisor } from "../events/engines.js";
import { EventHub } from "../events/hub.js";
import { LateSink } from "../events/late-sink.js";
import { RunMirror } from "../events/run-mirror.js";
import { JobManager } from "../jobs/jobs.js";
import { NodeProcessRunner, type ProcessRunner } from "../jobs/process.js";
import { Notifier } from "../notify/notifier.js";
import { DevServerProxy, cachedResolver, proxyPorts } from "../proxy/proxy.js";
import { Scheduler, VendorHealth } from "../scheduler/scheduler.js";
import { OpCli, type OpClient } from "../secrets/op.js";
import { BROKER_SYNC_INTERVAL_MS, SecretsBroker, assertSocketPathFits } from "../secrets/broker.js";
import { SecretsService } from "../secrets/secrets-service.js";
import { brokerDirFor, dataPath } from "../records/env.js";
import { SetupService } from "../setup/setup-service.js";
import { UpdateChecker } from "../setup/updates.js";
import { SshTunnelManager, startCopyIdJob, testConnection } from "../ssh/tunnels.js";
import { installService, serviceInstalled } from "../systemd/service.js";
import { DockerExecBackend, type ExecBackend } from "../terminals/exec.js";
import { UsageService } from "../usage/usage-service.js";
import { UsageStore } from "../usage/usage-store.js";

export interface AppOptions {
  home: string;
  /** The data directory in place of `~/.ai-orchestrator`; see `HostEnv.dataDir`. */
  dataDir?: string;
  createCore: CoreFactory;
  version: string;
  expectedEngineVersion: string;
  /** The command the systemd unit runs. */
  execStart: string;
  imageContext: string;
  staticDirs?: ApiDeps["staticDirs"];
  runner?: ProcessRunner;
  op?: OpClient;
  exec?: ExecBackend;
  fetch?: typeof fetch;
  /** Overrides the configured port; 0 picks a free one (tests). */
  port?: number;
  /**
   * The dev-server proxy port when `port` is set; 0 picks a free one.
   * Absent with `port` set means no proxy listener.
   */
  proxyPort?: number;
  engineIntervalMs?: number;
  /**
   * Engines of projects without a container, from `AIO_DEV_ENGINES`.
   * The server refuses them unless it binds to a loopback host.
   */
  devEngines?: EngineEndpoint[];
  log?: (message: string) => void;
}

/** The address the API server binds to. */
export const BIND_HOST = "127.0.0.1";

export interface App {
  core: Core & { close?(): Promise<void> };
  hub: EventHub;
  api: ApiServer;
  port: number;
  proxyPort: number | null;
  close(): Promise<void>;
}

export async function startApp(options: AppOptions): Promise<App> {
  const log = options.log ?? ((m: string) => console.error(m));
  const devEngines = options.devEngines ?? [];
  assertDevEnginesAllowed(devEngines, BIND_HOST);
  // Every container start opens a broker socket. Its directory name has a
  // fixed length, so a data directory too long for one is too long for all:
  // refuse it now rather than at the first start.
  assertSocketPathFits(
    path.join(
      brokerDirFor({ home: options.home, dataDir: options.dataDir }, "aio-agent-check"),
      BROKER_SOCKET_NAME,
    ),
  );
  const runner = options.runner ?? new NodeProcessRunner();
  const token = await loadOrCreateToken(options.home, options.dataDir);
  const tls = await loadOrCreateTlsIdentity(options.home, options.dataDir);
  const sink = new LateSink();
  let secrets: SecretsService | null = null;
  let runs: RunMirror | null = null;
  const broker = new SecretsBroker({
    source: {
      names: async (projectId) => {
        if (!secrets) throw new Error("The secrets service is not ready.");
        return secrets.names(projectId);
      },
      read: async (projectId, names) => {
        if (!secrets) throw new Error("The secrets service is not ready.");
        return secrets.readNames(projectId, names);
      },
    },
    dirFor: (container) =>
      brokerDirFor({ home: options.home, dataDir: options.dataDir }, container),
    log,
  });
  const services: CoreServices = {
    events: sink,
    prepareSecrets: async (projectId, container, tcp) => {
      if (!secrets) throw new Error("The secrets service is not ready.");
      const names = await secrets.preflight(projectId);
      // A container created with TCP gets a token no earlier container had.
      if (tcp) await broker.open({ container, projectId, tcpPort: tcp.port }, { rotateToken: true });
      else await broker.open({ container, projectId });
      return names;
    },
    brokerTcpPort: (container) => broker.tcpPort(container),
    sudoPasswordHash: async () => {
      if (!secrets) throw new Error("The secrets service is not ready.");
      return secrets.sudoPasswordHash();
    },
    activeRunForBox: (boxId) => runs?.activeRunForBox(boxId) ?? null,
  };
  const ports = new Map<string, Listener[]>();
  let engineSupervisor: EngineSupervisor | null = null;
  services.listeners = (container) => ports.get(container) ?? [];
  services.engineInfo = (container) => engineSupervisor?.info(container) ?? null;
  const core = await options.createCore({
    home: options.home,
    dataDir: options.dataDir,
    services,
    engineVersion: options.expectedEngineVersion,
    log,
  });
  const settings = () => core.settings.get();

  const hub = new EventHub({
    db: core.db,
    onListenerError: (err, event) =>
      log(`A listener failed on ${event.type}: ${(err as Error).message}`),
  });
  sink.attach(hub);
  runs = new RunMirror(core.db);
  const runMirror = runs;
  const usageStore = new UsageStore(core.db);
  const usage = new UsageService({ store: usageStore, settings, emit: (e) => hub.emit(e) });
  const vendorHealth = new VendorHealth();
  const scheduler = new Scheduler({
    usage,
    usable: (runId, vendor) => vendorHealth.usable(runId, vendor),
    settings,
    projectCeilings: async (projectId) =>
      (await core.projects.get(projectId)).project.ceilingsOverride,
    runRound: (runId) => runMirror.round(runId),
    emit: (e) => hub.emit(e),
  });
  const notifier = new Notifier({ db: core.db, settings, emit: (e) => hub.emit(e) });
  const op = options.op ?? new OpCli(runner);
  secrets = new SecretsService({
    op,
    settings,
    projectRefs: async (projectId) => (await core.projects.get(projectId)).project.secretRefs,
    listProjects: async () =>
      (await core.projects.list()).map((p) => ({
        projectId: p.project.id,
        refs: p.project.secretRefs,
      })),
  });
  const jobs = new JobManager({
    onFinished: (job) =>
      hub.emit({
        type: "terminal.ended",
        terminalId: job.id,
        boxId: job.boxId,
        kind: "job",
        exitCode: job.exitCode,
        unexpected: false,
      }),
  });
  const tunnels = new SshTunnelManager({ runner, remotes: () => core.sshRemotes.list(), log });
  const setup = new SetupService({
    core,
    jobs,
    runner,
    op,
    home: options.home,
    imageContext: options.imageContext,
    serviceInstalled: () => serviceInstalled(options.home),
    installService: async (io) => {
      await installService({
        home: options.home,
        execStart: options.execStart,
        runner,
        log: (s) => io.write(s),
      });
    },
  });
  const updates = new UpdateChecker({
    fetch: options.fetch,
    currentVersion: options.version,
    image: core.image,
  });

  const engines = new EngineSupervisor({
    engines: withDevEngines(core.engines, devEngines),
    db: core.db,
    expectedVersion: options.expectedEngineVersion,
    relay: (event) => hub.relay(event),
    decideLease: (engineKey, projectId, request) => scheduler.decide(engineKey, projectId, request),
    onRuns: (list) => list.forEach((run) => runMirror.upsert(run)),
    onFindings: (runId, findings) => runMirror.replaceFindings(runId, findings),
    onStreamReset: (engineKey) => scheduler.forget(engineKey),
    log,
    intervalMs: options.engineIntervalMs,
  });
  engineSupervisor = engines;

  let tunnelSync: NodeJS.Timeout | null = null;
  const syncTunnels = () => {
    if (tunnelSync) return;
    tunnelSync = setTimeout(async () => {
      tunnelSync = null;
      try {
        const running: Box[] = (await core.boxes.list({}))
          .filter((v) => v.status === "running")
          .map((v) => v.box);
        await tunnels.sync(running);
      } catch (err) {
        log(`SSH tunnel sync failed: ${(err as Error).message}`);
      }
    }, 200);
  };

  // Every running project container keeps a broker socket: a restarted
  // server recreates each one in its mounted directory, and a removed
  // container's socket closes. One sync runs at a time; a request during a
  // sync runs once more after it.
  let brokerSync: Promise<void> | null = null;
  let brokerSyncAgain = false;
  let closing = false;
  const syncBroker = (): void => {
    if (closing) return;
    if (brokerSync) {
      brokerSyncAgain = true;
      return;
    }
    brokerSync = (async () => {
      do {
        brokerSyncAgain = false;
        try {
          const running = (await core.engines.list()).map((e) => ({
            container: e.container,
            projectId: e.projectId,
            // The transport the container was created with: its environment
            // can't change, so a changed setting waits for a recreate.
            ...(e.brokerPort !== undefined ? { tcpPort: e.brokerPort } : {}),
          }));
          if (!closing) await broker.sync(running);
        } catch (err) {
          log(`Secrets broker sync failed: ${(err as Error).message}`);
        }
      } while (brokerSyncAgain && !closing);
    })().finally(() => {
      brokerSync = null;
    });
  };
  const brokerTimer = setInterval(syncBroker, BROKER_SYNC_INTERVAL_MS);
  brokerTimer.unref();

  hub.subscribe((event: AioEvent) => {
    runMirror.ingest(event);
    usage.ingest(event);
    vendorHealth.ingest(event);
    notifier.ingest(event);
    if (event.type === "box.changed") syncTunnels();
    if (event.type === "container.changed") {
      if (event.state !== "running") ports.delete(event.container);
      void engines.refresh();
      syncBroker();
    }
    if (event.type === "ports.changed") ports.set(event.container, event.listeners);
  });

  const proxy = new DevServerProxy(
    cachedResolver(async (hostKey) => {
      // The core keeps host keys unique across projects (migration 2 and
      // allocateHostKey()); refuse rather than guess if two ever match.
      const matches = (await core.boxes.list({})).filter((v) => v.box.hostKey === hostKey);
      const view = matches.length === 1 ? matches[0] : undefined;
      const endpoint = view ? engines.get(view.container)?.endpoint : undefined;
      if (!view || !endpoint?.hostPort) return null;
      const { project } = await core.projects.get(view.box.projectId);
      return {
        enginePort: endpoint.hostPort,
        token: endpoint.token,
        ...proxyPorts(
          view.box.id,
          () => ports.get(view.container) ?? [],
          project.tcpMaps.map((m) => m.container),
        ),
      };
    }),
  );

  const api = await createApiServer({
    core,
    home: options.home,
    token,
    version: options.version,
    startedAt: new Date(),
    hub,
    jobs,
    runs: runMirror,
    engines,
    usage: { vendors: () => usage.vendors(), samples: (q) => usageStore.samples(q) },
    notifications: notifier,
    secrets,
    setup,
    updates,
    ssh: {
      status: (name) => tunnels.status(name),
      reconnect: (name) => tunnels.reconnect(name),
      test: (remote) => testConnection(runner, remote),
      copyId: (remote) => startCopyIdJob(jobs, runner, remote),
    },
    exec: options.exec ?? new DockerExecBackend(core.docker.api),
    proxy,
    tls,
    staticDirs: options.staticDirs,
    log,
  });
  const config = settings();
  const port = await api.listen(options.port ?? config.serverPort, BIND_HOST);
  // The CLI reads the port from here: after the first start, the server
  // takes it from its database, not from config.json.
  try {
    await writeFile(
      dataPath({ home: options.home, dataDir: options.dataDir }, HOME_PATHS.serverPort),
      `${port}\n`,
      { mode: 0o644 },
    );
  } catch (err) {
    log(`Couldn't write server.port: ${(err as Error).message}`);
  }
  for (const e of devEngines) {
    log(`Development engine for project ${e.projectId} on port ${e.hostPort}.`);
  }

  // The proxy gets a plain HTTP listener of its own: the API listener's
  // certificate names loopback only, not `*.localhost`. Tests that pick the
  // API port pick the proxy port too, or go without the proxy listener.
  let proxyServer: http.Server | null = null;
  let proxyPort: number | null = null;
  const wantProxyPort = options.port === undefined ? proxyPortOf(config) : options.proxyPort;
  if (wantProxyPort !== undefined) {
    const server = http.createServer((req, res) => void proxy.handleRequest(req, res));
    server.on("upgrade", (req, socket, head) => void proxy.handleUpgrade(req, socket, head));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(wantProxyPort, BIND_HOST, () => {
          server.off("error", reject);
          resolve();
        });
      });
      proxyServer = server;
      const address = server.address();
      proxyPort = typeof address === "object" && address ? address.port : wantProxyPort;
    } catch (err) {
      // The API matters more than the proxy, so the server starts without it.
      log(`The dev-server proxy can't listen on port ${wantProxyPort}: ${(err as Error).message}`);
    }
  }

  engines.start();
  syncTunnels();
  syncBroker();

  return {
    core,
    hub,
    api,
    port,
    proxyPort,
    async close() {
      if (tunnelSync) clearTimeout(tunnelSync);
      // A running image build would otherwise keep the process alive.
      await jobs.stopAll();
      proxy.close();
      await api.close();
      if (proxyServer) await new Promise<void>((resolve) => proxyServer?.close(() => resolve()));
      await engines.stop();
      await tunnels.stopAll();
      closing = true;
      clearInterval(brokerTimer);
      await brokerSync;
      await broker.closeAll();
      await core.close?.();
    },
  };
}
