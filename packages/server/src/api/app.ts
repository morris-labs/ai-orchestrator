// Builds the whole server from a core: the event hub and its listeners, the
// engine supervisor, the scheduler, the HTTPS API server, and the plain HTTP
// listener of the dev-server proxy.
import http from "node:http";
import { proxyPortOf, type AgentBoxEvent, type Box, type Listener } from "@agentbox/contracts";
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
import { SecretsService } from "../secrets/secrets-service.js";
import { SetupService } from "../setup/setup-service.js";
import { UpdateChecker } from "../setup/updates.js";
import { SshTunnelManager, startCopyIdJob, testConnection } from "../ssh/tunnels.js";
import { installService, serviceInstalled } from "../systemd/service.js";
import { DockerExecBackend, type ExecBackend } from "../terminals/exec.js";
import { UsageService } from "../usage/usage-service.js";
import { UsageStore } from "../usage/usage-store.js";

export interface AppOptions {
  home: string;
  /** The data directory in place of `~/.claude-box`; see `HostEnv.dataDir`. */
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
   * Engines of projects without a container, from `AGENTBOX_DEV_ENGINES`.
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
  const runner = options.runner ?? new NodeProcessRunner();
  const token = await loadOrCreateToken(options.home, options.dataDir);
  const tls = await loadOrCreateTlsIdentity(options.home, options.dataDir);
  const sink = new LateSink();
  let secrets: SecretsService | null = null;
  let runs: RunMirror | null = null;
  const services: CoreServices = {
    events: sink,
    resolveSecrets: async (projectId) => {
      if (!secrets) throw new Error("The secrets service is not ready.");
      secrets.beginLaunch();
      return secrets.resolveEnv(projectId);
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

  hub.subscribe((event: AgentBoxEvent) => {
    runMirror.ingest(event);
    usage.ingest(event);
    vendorHealth.ingest(event);
    notifier.ingest(event);
    if (event.type === "box.changed") syncTunnels();
    if (event.type === "container.changed") {
      if (event.state !== "running") ports.delete(event.container);
      void engines.refresh();
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
      await core.close?.();
    },
  };
}
