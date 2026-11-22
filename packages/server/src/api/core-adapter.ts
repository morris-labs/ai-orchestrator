// Maps the core modules (`ServerCore` in `src/core.ts`) onto the `Core`
// interface the API and the services use. The core modules work in records
// and mostly synchronous calls; the API works in views and promises. This
// file is the only place that knows both shapes.
import path from "node:path";
import fs from "node:fs";
import { stateFile } from "../docker/state.js";
import type { Box, BoxView, ReviewState } from "@aio/contracts";
import type Docker from "dockerode";
import type { ServerCore } from "../core.js";
import { summarizeImport } from "../import/importer.js";
import { readPolicy, writePolicy } from "../projects/policy.js";
import type { Core, CoreServices, EngineEndpoint } from "./core-interface.js";

/** The stats part of a box view, from the monitor's last sample of its container. */
function statsOf(server: ServerCore, container: string): BoxView["stats"] {
  const s = server.monitor.statsFor(container);
  return s
    ? { cpuPercent: s.cpuPercent, memBytes: s.memBytes, memLimitBytes: s.memLimitBytes }
    : null;
}

/** The review state of a box: under review while a run holds its working tree. */
export function reviewStateOf(services: CoreServices, boxId: string): ReviewState {
  const runId = services.activeRunForBox(boxId);
  return runId === null ? { state: "idle" } : { state: "under_review", runId };
}

/**
 * Installs the server's services as the core's hooks: secrets for launches,
 * review state, listeners, and engine health.
 */
export function wireHooks(server: ServerCore, services: CoreServices): void {
  server.setHooks({
    // Two arguments for the Unix socket, as before the TCP transport.
    prepareSecrets: (projectId, container, broker) =>
      broker
        ? services.prepareSecrets(projectId, container, broker)
        : services.prepareSecrets(projectId, container),
    brokerTcpPort: (container) => services.brokerTcpPort?.(container) ?? null,
    sudoPasswordHash: async () => (services.sudoPasswordHash ? services.sudoPasswordHash() : null),
    reviewState: (boxId) => reviewStateOf(services, boxId),
    listeners: (container) => services.listeners?.(container) ?? [],
    engineHealth: (container) => {
      const info = services.engineInfo?.(container) ?? null;
      return info
        ? { version: info.version, healthy: info.healthy, versionMatches: info.versionMatches }
        : { version: null, healthy: false };
    },
  });
}

/**
 * Relays the core's events into the server's event sink, and reports a box
 * session that ended on its own as `terminal.ended`, which the notifier
 * turns into a `box_ended` notification. Returns the function that stops
 * relaying.
 */
export function relayEvents(server: ServerCore, services: CoreServices): () => void {
  const unsubscribe = server.events.subscribe((payload) => {
    services.events.emit(payload);
  });
  const onEnded = (e: { boxId: string; unexpected: boolean }) => {
    services.events.emit({
      type: "terminal.ended",
      terminalId: `session:${e.boxId}`,
      boxId: e.boxId,
      kind: "session",
      exitCode: null,
      unexpected: e.unexpected,
    });
  };
  server.monitor.on("boxEnded", onEnded);
  return () => {
    unsubscribe();
    server.monitor.off("boxEnded", onEnded);
  };
}

/** Builds the API's `Core` over the core modules. `dockerApi` serves terminal exec. */
export function apiCoreOf(server: ServerCore, dockerApi: Docker): Core {
  const { boxes, projects, settings } = server;
  const view = (box: Box): BoxView => boxes.view(box, statsOf(server, box.container));
  const viewOf = (id: string): BoxView => view(boxes.get(id));

  return {
    db: server.db.sqlite,
    docker: {
      api: dockerApi,
      ping: () => server.docker.ping(),
      refreshStats: () => server.monitor.poll({ sampleStats: true }),
    },
    image: { status: () => server.image.status() },

    projects: {
      list: () => projects.summaries(),
      create: async (input) => projects.create(input),
      get: async (projectId) => projects.summary(projects.get(projectId)),
      update: (projectId, patch) => projects.update(projectId, patch),
      restartContainer: (projectId) => boxes.restartProjectContainer(projectId),
      recreateContainer: async (projectId) => {
        const container = projects.containerName(projects.get(projectId));
        for (const box of boxes.list(projectId)) {
          await boxes.syncRecordFromSession(box.id).catch(() => false);
        }
        await server.docker.removeContainer(container, { force: true });
        fs.rmSync(stateFile(server.env, container), { force: true });
        await projects.ensureContainer(projectId);
      },
      remove: (projectId, force) => boxes.removeProject(projectId, { force }),
      getPolicy: async (projectId) => readPolicy(projects.policyFile(projects.get(projectId))),
      putPolicy: async (projectId, policy, baseRevision) =>
        writePolicy(projects.policyFile(projects.get(projectId)), policy, baseRevision),
    },

    boxes: {
      list: async (query) => boxes.list(query.projectId).map(view),
      get: async (boxId) => viewOf(boxId),
      validateCreate: (input) => boxes.validateCreate(input),
      // The core streams nothing while it creates a box; the job terminal
      // gets the outcome.
      create: async (input, log) => {
        const box = await boxes.create(input);
        log(`Created ${box.id}.\r\n`);
        return box;
      },
      update: async (boxId, patch) => {
        const r = await boxes.update(boxId, patch);
        return { box: view(r.box), restartRequired: r.restartRequired };
      },
      start: async (boxId, options) => view(await boxes.start(boxId, { force: options?.force })),
      stop: async (boxId) => view(await boxes.stop(boxId)),
      restart: async (boxId) => view(await boxes.restart(boxId)),
      remove: (boxId, options) => boxes.remove(boxId, options),
      purge: (boxId, options) => boxes.purge(boxId, options),
      move: (boxId, newDir) => boxes.move(boxId, newDir),
      relink: async (boxId, targetDir) => view(await boxes.relink(boxId, targetDir)),
      validateConvertToWorktree: async (boxId) => {
        await boxes.planConvertToWorktree(boxId);
      },
      planConvertToWorktree: (boxId) => boxes.planConvertToWorktree(boxId),
      convertToWorktree: (boxId, options, log) => boxes.convertToWorktree(boxId, options, log),
      startSideSession: (boxId, platform) => boxes.startSideSession(boxId, platform),
      stopSideSession: (boxId, platform) => boxes.stopSideSession(boxId, platform),
      setPlatform: async (boxId, platform, restart) =>
        view(await boxes.setPlatform(boxId, platform, restart)),
      message: (boxId, text) => boxes.sendMessage(boxId, text),
      startAll: (onlyWasRunning) => boxes.startAll(onlyWasRunning),
      stopAll: () => boxes.stopAll(),
      restartAll: () => boxes.restartAll(),
    },

    catalog: {
      list: async (dir) => ({
        dir: path.resolve(dir),
        conversations: await boxes.conversations(dir),
      }),
    },
    models: {
      list: (dir, account, vendor) => server.models.list(dir, account, vendor),
      rescan: (vendor) => server.models.rescan(undefined, vendor),
    },

    settings: {
      get: () => settings.get(),
      patch: async (patch) => settings.patch(patch),
      setPromptTemplates: async (templates) => settings.setPromptTemplates(templates),
      setGlobalMounts: async (mounts) => {
        const saved = settings.setGlobalMounts(mounts);
        const staleContainers: string[] = [];
        for (const project of projects.list()) {
          if ((await projects.staleDifferences(project)).length > 0) {
            staleContainers.push(projects.containerName(project));
          }
        }
        return { mounts: saved.globalMounts, staleContainers };
      },
      setSecretRefs: async (refs) => settings.setSecretRefs(refs),
      completeSetup: async (input) => settings.completeSetup(input.defaultTargetDir),
    },

    sshRemotes: {
      list: async () => server.sshRemotes.list().map((v) => v.remote),
      get: async (name) => server.sshRemotes.get(name).remote,
      put: async (name, remote) => server.sshRemotes.put(name, remote).remote,
      delete: async (name) => server.sshRemotes.delete(name),
    },

    accounts: {
      prepare: async ({ vendor, name }) => server.accounts.prepareAccount(vendor, name),
      list: async () => server.accounts.list(),
      get: async (id) => server.accounts.view(server.accounts.get(id)),
      create: async (input) => server.accounts.create(input),
      update: async (id, patch) => server.accounts.update(id, patch),
      remove: async (id) => server.accounts.remove(id),
      check: (id) => server.accounts.check(id),
      relink: async () => server.accounts.relink(),
      adoptTranscripts: async (input) => server.accounts.adoptTranscripts(input),
      importFolder: (input) => server.accounts.importFolder(input),
      validateSeed: async (input) => {
        server.accounts.validateSeed(input);
      },
      seed: (input, log) => server.accounts.seed(input, log),
    },

    engines: {
      // Only containers that run have an engine to talk to.
      list: async () => {
        const endpoints: EngineEndpoint[] = [];
        for (const e of server.db.engines.list()) {
          // `inspectContainer` answers null for a missing container. A failed
          // inspect says nothing, so a Docker blip keeps the engine's client.
          const inspect = await server.docker
            .inspectContainer(e.container)
            .catch(() => ({ running: true }));
          if (!inspect?.running) continue;
          endpoints.push({
            container: e.container,
            projectId: e.projectId,
            hostPort: e.hostPort,
            token: e.token,
            ...(e.brokerPort !== undefined ? { brokerPort: e.brokerPort } : {}),
          });
        }
        return endpoints;
      },
    },

    legacyImport: {
      run: async ({ dryRun }) => summarizeImport(server.legacyImport.run(false, dryRun), dryRun),
    },
  };
}
