// Builds the whole server from a core: the event hub and its listeners, the
// engine supervisor, the scheduler, the HTTPS API server, and the plain HTTP
// listener of the dev-server proxy.
import { writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  BROKER_SOCKET_NAME,
  RunStateSchema,
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
import { BoxBuildLink } from "../events/build-control.js";
import { BuildMirror } from "../events/build-mirror.js";
import { RunMirror } from "../events/run-mirror.js";
import { JobManager } from "../jobs/jobs.js";
import { NodeProcessRunner, type ProcessRunner } from "../jobs/process.js";
import { Notifier } from "../notify/notifier.js";
import { DevServerProxy, cachedResolver, proxyPorts } from "../proxy/proxy.js";
import { Scheduler, VendorHealth } from "../scheduler/scheduler.js";
import { OpCli, type OpClient } from "../secrets/op.js";
import { BROKER_SYNC_INTERVAL_MS, SecretsBroker, assertSocketPathFits } from "../secrets/broker.js";
import { SecretsService } from "../secrets/secrets-service.js";
import { brokerDirFor, dataDirOf, dataPath } from "../records/env.js";
import { MultiHost, type MachineRole, type MultiHostOptions } from "../hub/multihost.js";
import { UpgradeService, imageBuildFailureMessage, saveImageBuildLog } from "../setup/upgrade.js";
import { SetupService } from "../setup/setup-service.js";
import { UpdateChecker } from "../setup/updates.js";
import { RELEASE_EDITS_MESSAGE } from "./handlers.js";
import { SshTunnelManager, startCopyIdJob, testConnection } from "../ssh/tunnels.js";
import { currentPlatform, serviceManagerOf, type HostPlatform } from "../platform/host.js";
import { installServerService, serverServiceInstalled } from "../service/index.js";
import { installService, serviceInstalled } from "../systemd/service.js";
import { DockerExecBackend, type ExecBackend } from "../terminals/exec.js";
import { UsageService } from "../usage/usage-service.js";
import { UsageStore } from "../usage/usage-store.js";
import { UsageWatcher, projectManagerBoxes, projectManagerMessage } from "../usage/watcher.js";
import { PmDelivery } from "../events/pm-delivery.js";

export interface AppOptions {
  home: string;
  /** The data directory in place of `~/.ai-orchestrator`; see `HostEnv.dataDir`. */
  dataDir?: string;
  createCore: CoreFactory;
  version: string;
  expectedEngineVersion: string;
  /** The command the systemd unit runs. */
  execStart: string;
  /**
   * The argv that starts the server, for the launchd agent on macOS and
   * the logon task on Windows. Linux uses `execStart`.
   */
  serverCommand?: string[];
  /** The host operating system. Default: the one the process runs on. */
  platform?: HostPlatform;
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
  /** The role from `--role` or `AIO_ROLE`; wins over the stored setting. */
  role?: MachineRole;
  /** Overrides the hub's link port; 0 picks a free one (tests). */
  linkPort?: number;
  /** Overrides the hub's GUI port; 0 picks a free one (tests). */
  guiPort?: number;
  /** The address the hub's link listener binds, which wins over the setting. Default: the LAN address. */
  linkHost?: string;
  /** Finds the primary LAN IPv4 address for the link listener (tests). */
  lanAddress?: () => string | undefined;
  /** Overrides the host name in hub URLs (tests). */
  linkAddress?: string;
  /** Overrides the link protocol version (tests). */
  linkProtocol?: number;
  /** Milliseconds between checks of the synced sign-in files; 0 turns the timer off (tests). */
  credentialPollMs?: number;
  /** Link pings, timeouts, and reconnect delays (tests). */
  linkTiming?: MultiHostOptions["timing"];
}

/** The address the API server binds to. */
export const BIND_HOST = "127.0.0.1";

export interface App {
  core: Core & { close?(): Promise<void> };
  multiHost: MultiHost;
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
  const platform = options.platform ?? currentPlatform(options.home);
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
      if (tcp)
        await broker.open({ container, projectId, tcpPort: tcp.port }, { rotateToken: true });
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
  const buildMirror = new BuildMirror(core.db);
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
  const notifier = new Notifier({
    db: core.db,
    settings,
    emit: (e) => hub.emit(e),
    builds: buildMirror,
    releaseBox: (boxId) => {
      void core.boxes.message(boxId, RELEASE_EDITS_MESSAGE).catch((err: unknown) => {
        log(`Telling ${boxId} that the run ended failed: ${(err as Error).message}`);
      });
    },
  });
  // Escalations, digests, and usage alerts reach the Project manager's session.
  const pmDelivery = new PmDelivery({
    builds: buildMirror,
    engines: { get: (container) => engineSupervisor?.get(container) },
    boxes: { deliver: (boxId, request) => core.boxes.deliver(boxId, request) },
    log,
  });
  const usageWatcher = new UsageWatcher({
    store: usageStore,
    settings,
    build: (buildId) => buildMirror.get(buildId),
    alerted: (buildId) => notifier.hasBuildAlert(buildId),
    alert: (alert) => {
      notifier.usageAlert(alert);
      const text = projectManagerMessage(alert);
      for (const boxId of projectManagerBoxes(alert, buildMirror.list())) {
        pmDelivery.alert(boxId, text);
      }
    },
  });
  let apiServer: ApiServer | null = null;
  const multiHost = new MultiHost({
    home: options.home,
    credentialPollMs: options.credentialPollMs,
    dataDir: dataDirOf({ home: options.home, dataDir: options.dataDir }),
    db: core.db,
    settings,
    patchSettings: (patch) => core.settings.patch(patch),
    roleOverride: options.role,
    version: options.version,
    expectedEngineVersion: options.expectedEngineVersion,
    imageStatus: () => core.image.status(),
    token,
    api: () => apiServer?.app ?? null,
    op: options.op ?? new OpCli(runner),
    linkHost: options.linkHost,
    lanAddress: options.lanAddress,
    linkPort: options.linkPort,
    guiPort: options.guiPort,
    linkAddress: options.linkAddress,
    protocol: options.linkProtocol,
    timing: options.linkTiming,
    log,
  });
  // A plain node asks its hub for secrets; see `hub/secrets-relay.ts`.
  const op = multiHost.op;
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
    dataDir: options.dataDir,
    imageContext: options.imageContext,
    platform,
    serviceInstalled: () =>
      serviceManagerOf(platform) === "systemd"
        ? serviceInstalled(options.home)
        : serverServiceInstalled(platform, runner),
    installService: async (io) => {
      if (serviceManagerOf(platform) === "systemd") {
        await installService({
          home: options.home,
          execStart: options.execStart,
          runner,
          log: (s) => io.write(s),
        });
        return;
      }
      if (!options.serverCommand) throw new Error("The server command is unknown.");
      await installServerService({
        platform,
        command: options.serverCommand,
        dataDir: options.dataDir,
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
    onPorts: (container, listeners) => ports.set(container, listeners),
    onStreamReset: (engineKey) => scheduler.forget(engineKey),
    log,
    intervalMs: options.engineIntervalMs,
  });
  engineSupervisor = engines;
  let upgradeBuildJob: string | null = null;
  const buildLogFile = path.join(
    dataDirOf({ home: options.home, dataDir: options.dataDir }),
    "upgrade-image-build.log",
  );
  const upgrade = new UpgradeService({
    core,
    recordFile: path.join(
      dataDirOf({ home: options.home, dataDir: options.dataDir }),
      "upgrade-open-work.json",
    ),
    runs: () => runMirror.list(),
    imageCurrent: async () => {
      const status = await core.image.status();
      return status.exists && status.engineMatches;
    },
    build: async (signal, progress) => {
      const job = setup.buildImage("upgrade");
      upgradeBuildJob = job.id;
      const stop = () => jobs.stop(job.id);
      signal?.addEventListener("abort", stop, { once: true });
      const attachment = jobs.attach(job.id);
      if (!attachment) throw new Error("Image build job is unavailable");
      let output = attachment.backlog.toString();
      attachment.onData((chunk) => {
        const text = chunk.toString();
        output += text;
        const line = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .at(-1);
        progress?.(line ?? "");
      });
      try {
        await new Promise<void>((resolve, reject) =>
          attachment.onDone((done) => {
            const saved = saveImageBuildLog(buildLogFile, output);
            if (done.status === "failed" || done.exitCode !== 0)
              reject(
                new Error(
                  imageBuildFailureMessage(
                    output,
                    saved ? buildLogFile : null,
                    done.error?.message ?? "Latest and pinned image builds failed",
                  ),
                ),
              );
            else resolve();
          }),
        );
      } finally {
        signal?.removeEventListener("abort", stop);
        attachment.detach();
      }
      return output.includes("AIO_UPGRADE_IMAGE=pinned") ? "pinned" : "latest";
    },
    resume: async (projectId, runId, signal) => {
      const deadline = Date.now() + 240_000;
      while (true) {
        if (signal?.aborted) throw new Error("Upgrade time limit reached");
        try {
          await engines.refresh();
          const engine = engines.requireProject(projectId);
          await engine.confirmVersion();
          const state = RunStateSchema.parse(
            await engine.call("engine.runs.get", { params: { runId } }),
          );
          // Boot already resumes saved pending/running work. A paused run
          // needs resume; newer-state refusals preserve their exact notice.
          if (state.status === "paused")
            await engine.call("engine.runs.resume", { params: { runId } });
          return;
        } catch (err) {
          const message = (err as Error).message;
          if ((err as { code?: unknown }).code === "run_not_found") throw err;
          if (
            /state version|newer|saved by|unsupported|cannot resume/i.test(message) ||
            Date.now() >= deadline
          )
            throw err;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    },
    log,
  });

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

  // A box stop pauses the box's build, and its start resumes it.
  const boxBuilds = new BoxBuildLink({ builds: buildMirror, engines, log });
  hub.subscribe((event: AioEvent) => {
    runMirror.ingest(event);
    buildMirror.ingest(event);
    boxBuilds.ingest(event);
    pmDelivery.ingest(event);
    usage.ingest(event);
    // After the usage service, which records the sample or settlement it reads.
    usageWatcher.ingest(event);
    vendorHealth.ingest(event);
    notifier.ingest(event);
    if (event.type === "box.changed") syncTunnels();
    if (event.type === "settings.changed" && event.changedKeys.includes("role")) {
      multiHost.node.reconcile();
    }
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
    usage: {
      vendors: () => usage.vendors(),
      forgetAccount: (vendor, account) => void usageStore.removeAccount(vendor, account),
      clear: async (vendor, account) =>
        usage.clear(
          vendor,
          account,
          (await core.projects.list()).flatMap((p) => p.project.ceilingsOverride ?? []),
        ),
      samples: (q) => usageStore.samples(q),
    },
    builds: {
      list: (projectId) => buildMirror.list(projectId),
      get: (buildId) => buildMirror.get(buildId),
      usage: (buildId) =>
        buildMirror.get(buildId) === undefined ? undefined : usageStore.buildUsage(buildId),
      messages: (buildId) => buildMirror.messages(buildId),
      tasks: (buildId) => buildMirror.tasks(buildId),
    },
    notifications: notifier,
    secrets,
    setup,
    upgrade,
    upgradeBuildJob: () => upgradeBuildJob,
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
    links: multiHost.links,
    machines: {
      get role() {
        return multiHost.role();
      },
      get machineId() {
        return multiHost.machineId();
      },
      isKnown: (id) => multiHost.isKnown(id),
    },
    multiHost,
    log,
  });
  apiServer = api;
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
  pmDelivery.start();
  // Keep the API available while building so apps can show progress and starts wait.
  void core.image
    .status()
    .then((status) => {
      if (upgrade.hasOpenWork || (status.exists && !status.engineMatches)) return upgrade.start();
    })
    .catch((err) => log(`Startup upgrade failed: ${(err as Error).message}`));
  syncTunnels();
  syncBroker();
  try {
    await multiHost.start();
  } catch (err) {
    log(`Multi-host failed to start: ${(err as Error).message}`);
  }

  return {
    core,
    multiHost,
    hub,
    api,
    port,
    proxyPort,
    async close() {
      if (tunnelSync) clearTimeout(tunnelSync);
      // A running image build would otherwise keep the process alive.
      await jobs.stopAll();
      await multiHost.close();
      proxy.close();
      await api.close();
      if (proxyServer) await new Promise<void>((resolve) => proxyServer?.close(() => resolve()));
      await engines.stop();
      await tunnels.stopAll();
      closing = true;
      clearInterval(brokerTimer);
      boxBuilds.close();
      pmDelivery.close();
      await brokerSync;
      await broker.closeAll();
      await core.close?.();
    },
  };
}
