// One handler per HTTP route in the contracts' `serverRoutes` table. The
// `HttpHandlers` type makes a missing or extra route a compile error.
import {
  DEFAULT_PROMPT_TEMPLATES,
  boxWorkDir,
  type EngineRouteKey,
  type PathParams,
  type RunState,
  type ServerRoutes,
} from "@agentbox/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import { hasBearer, sessionCookieHeader } from "./auth.js";
import type { ApiDeps, ApiEngine } from "./deps.js";
import { ApiError } from "./errors.js";
import { listDirs } from "./fs-dirs.js";
import { ulid } from "./ulid.js";
import { commandLine } from "../jobs/process.js";
import { externalAttachArgv } from "../terminals/attach.js";

type SR = ServerRoutes;
export type HttpRouteKey = {
  [K in keyof SR]: SR[K] extends { kind: "http" } ? K : never;
}[keyof SR];
type Out<T> = T extends z.ZodTypeAny ? z.output<T> : undefined;

export interface HandlerContext<K extends HttpRouteKey> {
  params: PathParams<SR[K]["path"]>;
  query: SR[K] extends { query: infer Q } ? Out<Q> : undefined;
  body: SR[K] extends { body: infer B } ? Out<B> : undefined;
  request: FastifyRequest;
  reply: FastifyReply;
}

export type HttpHandlers = {
  [K in HttpRouteKey]: (ctx: HandlerContext<K>) => Promise<z.input<SR[K]["response"]>>;
};

/** The message a box's interactive session receives when a run starts on its tree. */
export const HOLD_EDITS_MESSAGE =
  "A review run has started on this branch. Hold all edits to the working tree until the run finishes; you will get a message when it does.";

/** The run routes that the server forwards to an engine unchanged. */
const RUN_PROXY_KEYS = [
  "runs.get",
  "runs.pause",
  "runs.resume",
  "runs.cancel",
  "runs.profile",
  "runs.assign",
  "runs.rebaseBase",
  "runs.decide",
  "runs.push",
  "runs.groups",
  "runs.rounds",
  "findings.list",
  "findings.get",
  "findings.waive",
] as const;
type RunProxyKey = (typeof RUN_PROXY_KEYS)[number];

/** Returns true when a value looks like a `RunState` the mirror can keep. */
function isRunState(value: unknown): value is RunState {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "status" in value &&
    "container" in value &&
    "request" in value
  );
}

export function createHandlers(deps: ApiDeps): HttpHandlers {
  const { core } = deps;

  /** Finds the engine that holds a run: the mirror first, then every engine. */
  async function engineForRun(runId: string): Promise<ApiEngine> {
    const known = deps.runs.get(runId);
    if (known) {
      const engine = deps.engines.get(known.container);
      if (!engine) {
        throw new ApiError(
          "conflict",
          `The container ${known.container} that holds run ${runId} is not running.`,
        );
      }
      engine.assertVersion();
      return engine;
    }
    for (const engine of deps.engines.all()) {
      try {
        const run = await engine.call("engine.runs.get", { params: { runId } });
        if (isRunState(run)) deps.runs.upsert(run);
        engine.assertVersion();
        return engine;
      } catch (err) {
        if ((err as ApiError).code !== "run_not_found") throw err;
      }
    }
    throw new ApiError("run_not_found", `No run has the id ${runId}.`);
  }

  function proxyRun<K extends RunProxyKey>(key: K): HttpHandlers[K] {
    return (async (ctx: HandlerContext<K>) => {
      const params = ctx.params as Record<string, string>;
      const engine = await engineForRun(params.runId as string);
      const result = await engine.call(`engine.${key}` as EngineRouteKey, {
        params,
        query: ctx.query as Record<string, unknown> | undefined,
        body: ctx.body,
      });
      if (isRunState(result)) deps.runs.upsert(result);
      return result;
    }) as unknown as HttpHandlers[K];
  }

  const runProxies = Object.fromEntries(RUN_PROXY_KEYS.map((k) => [k, proxyRun(k)])) as {
    [K in RunProxyKey]: HttpHandlers[K];
  };

  return {
    health: async () => ({
      version: deps.version,
      uptimeS: (Date.now() - deps.startedAt.getTime()) / 1000,
    }),
    "auth.session": async ({ request, reply }) => {
      if (!hasBearer({ authorization: request.headers.authorization }, deps.token)) {
        throw new ApiError("unauthorized", "Setting the session cookie needs the bearer header.");
      }
      reply.header("set-cookie", sessionCookieHeader(deps.token));
      return { ok: true };
    },

    // Projects
    "projects.list": async () => ({ projects: await core.projects.list() }),
    "projects.create": async ({ body }) => core.projects.create(body),
    "projects.get": async ({ params }) => core.projects.get(params.projectId),
    "projects.update": async ({ params, body }) => core.projects.update(params.projectId, body),
    "projects.restartContainer": async ({ params }) =>
      core.projects.restartContainer(params.projectId),
    "projects.policy.get": async ({ params }) => core.projects.getPolicy(params.projectId),
    "projects.policy.put": async ({ params, body }) =>
      core.projects.putPolicy(params.projectId, body),
    "projects.repos.list": async ({ params }) => {
      await core.projects.get(params.projectId);
      return deps.engines.requireProject(params.projectId).call("engine.repos.list") as never;
    },
    "projects.repos.refs": async ({ params, query }) => {
      await core.projects.get(params.projectId);
      return deps.engines
        .requireProject(params.projectId)
        .call("engine.repos.refs", { query }) as never;
    },

    // Boxes
    "boxes.list": async ({ query }) => ({ boxes: await core.boxes.list(query) }),
    "boxes.create": async ({ body }) => {
      await core.boxes.validateCreate(body);
      const label = body.conversationName.trim() || body.targetDir;
      return deps.jobs.start(
        { kind: "box_create", command: `Create box "${label}"` },
        async (io) => {
          const box = await core.boxes.create(body, (text) => io.write(text));
          return { exitCode: 0, result: { box } };
        },
      );
    },
    "boxes.get": async ({ params }) => core.boxes.get(params.boxId),
    "boxes.update": async ({ params, body }) => core.boxes.update(params.boxId, body),
    "boxes.start": async ({ params, body }) =>
      core.boxes.start(params.boxId, { force: body.force }),
    "boxes.stop": async ({ params }) => core.boxes.stop(params.boxId),
    "boxes.restart": async ({ params }) => core.boxes.restart(params.boxId),
    "boxes.remove": async ({ params, query }) =>
      core.boxes.remove(params.boxId, { removeWorktree: query.removeWorktree }),
    "boxes.purge": async ({ params, body }) =>
      core.boxes.purge(params.boxId, { dryRun: body.dryRun }),
    "boxes.move": async ({ params, body }) => core.boxes.move(params.boxId, body.newDir),
    "boxes.relink": async ({ params, body }) => core.boxes.relink(params.boxId, body.targetDir),
    "boxes.convertToWorktree": async ({ params, body }) => {
      await core.boxes.validateConvertToWorktree(params.boxId);
      return deps.jobs.start(
        {
          kind: "convert_to_worktree",
          command: `Convert ${params.boxId} to a worktree`,
          boxId: params.boxId,
        },
        async (io) => {
          const result = await core.boxes.convertToWorktree(
            params.boxId,
            { copyBuildOutput: body.copyBuildOutput },
            (text) => io.write(text),
          );
          return { exitCode: 0, result };
        },
      );
    },
    "boxes.convertToWorktree.plan": async ({ params }) =>
      core.boxes.planConvertToWorktree(params.boxId),
    "boxes.attachCommand": async ({ params, query }) => {
      const view = await core.boxes.get(params.boxId);
      return {
        argv: externalAttachArgv({
          container: view.container,
          kind: query.kind,
          session: view.tmuxSession,
          platform: query.platform,
          workDir: boxWorkDir(view.box),
        }),
      };
    },
    "boxes.sideSessions.start": async ({ params, body }) =>
      core.boxes.startSideSession(params.boxId, body.platform),
    "boxes.sideSessions.stop": async ({ params }) => {
      const platform = params.platform;
      if (platform !== "claude" && platform !== "codex" && platform !== "copilot") {
        throw new ApiError("validation", `${platform} is not a platform.`);
      }
      await core.boxes.stopSideSession(params.boxId, platform);
      return { ok: true };
    },
    "boxes.platform": async ({ params, body }) =>
      core.boxes.setPlatform(params.boxId, body.platform, body.restart),
    "boxes.message": async ({ params, body }) => {
      await core.boxes.message(params.boxId, body.text);
      return { ok: true };
    },
    "boxes.startAll": async ({ body }) => core.boxes.startAll(body.onlyWasRunning),
    "boxes.stopAll": async () => core.boxes.stopAll(),
    "boxes.restartAll": async () => core.boxes.restartAll(),
    "stats.refresh": async () => {
      await core.docker.refreshStats();
      return { ok: true };
    },

    // Jobs
    "jobs.get": async ({ params }) => {
      const job = deps.jobs.get(params.jobId);
      if (!job) throw new ApiError("not_found", `No job has the id ${params.jobId}.`);
      return job;
    },

    // Catalog, models, image, updates, setup, settings, prompts
    "conversations.list": async ({ query }) => core.catalog.list(query.dir),
    "models.list": async ({ query }) => core.models.list(query.dir),
    "models.rescan": async () => core.models.rescan(),
    "image.status": async () => core.image.status(),
    "image.build": async ({ body }) => deps.setup.buildImage(body.kind),
    "updates.check": async ({ query }) => deps.updates.check(query.force),
    "setup.get": async () => deps.setup.status(),
    "setup.fix": async ({ params }) => deps.setup.fix(params.checkId),
    "setup.complete": async ({ body }) => {
      await core.settings.completeSetup(body);
      return { ok: true };
    },
    "import.run": async ({ body }) => core.legacyImport.run({ dryRun: body.dryRun }),
    "fs.dirs": async ({ query }) => listDirs(deps.home, query.path),
    "settings.get": async () => core.settings.get(),
    "settings.patch": async ({ body }) => core.settings.patch(body),
    "prompts.get": async () => ({
      templates: core.settings.get().promptTemplates,
      defaults: DEFAULT_PROMPT_TEMPLATES,
    }),
    "prompts.put": async ({ body }) => {
      const settings = await core.settings.setPromptTemplates(body);
      return { templates: settings.promptTemplates, defaults: DEFAULT_PROMPT_TEMPLATES };
    },

    // SSH remotes, global mounts, secrets
    "sshRemotes.list": async () => {
      const [remotes, boxes] = await Promise.all([core.sshRemotes.list(), core.boxes.list({})]);
      return {
        remotes: remotes.map((remote) => ({
          remote,
          referencedBy: boxes
            .filter((b) => b.box.sshRemoteRefs.includes(remote.name))
            .map((b) => b.box.id),
          ...deps.ssh.status(remote.name),
        })),
      };
    },
    "sshRemotes.put": async ({ params, body }) => {
      const remote = await core.sshRemotes.put(params.name, body);
      const boxes = await core.boxes.list({});
      return {
        remote,
        referencedBy: boxes
          .filter((b) => b.box.sshRemoteRefs.includes(remote.name))
          .map((b) => b.box.id),
        ...deps.ssh.status(remote.name),
      };
    },
    "sshRemotes.delete": async ({ params }) => core.sshRemotes.delete(params.name),
    "sshRemotes.test": async ({ body }) => deps.ssh.test(body),
    "sshRemotes.testSaved": async ({ params, body }) =>
      deps.ssh.test(body ?? (await core.sshRemotes.get(params.name))),
    "sshRemotes.reconnect": async ({ params }) => {
      const remote = await core.sshRemotes.get(params.name);
      await deps.ssh.reconnect(remote.name);
      const boxes = await core.boxes.list({});
      return {
        remote,
        referencedBy: boxes
          .filter((b) => b.box.sshRemoteRefs.includes(remote.name))
          .map((b) => b.box.id),
        ...deps.ssh.status(remote.name),
      };
    },
    "sshRemotes.copyId": async ({ params }) =>
      deps.ssh.copyId(await core.sshRemotes.get(params.name)),
    "globalMounts.get": async () => ({ mounts: core.settings.get().globalMounts }),
    "globalMounts.put": async ({ body }) => core.settings.setGlobalMounts(body.mounts),
    "secrets.get": async () => deps.secrets.view(),
    "secrets.put": async ({ body }) => {
      const settings = await core.settings.setSecretRefs(body.refs);
      return { refs: settings.secretRefs };
    },
    "secrets.check": async ({ body }) => deps.secrets.check(body.projectId),

    // Review
    "runs.list": async ({ query }) => {
      let projectId = query.projectId;
      if (projectId === undefined && query.boxId !== undefined) {
        projectId = (await core.boxes.get(query.boxId)).box.projectId;
      }
      const engines =
        projectId === undefined
          ? deps.engines.all()
          : [deps.engines.forProject(projectId)].filter((e): e is ApiEngine => e !== undefined);
      const byId = new Map<string, RunState>();
      for (const run of deps.runs.list(query)) byId.set(run.id, run);
      await Promise.all(
        engines.map(async (engine) => {
          try {
            const { runs } = (await engine.call("engine.runs.list", { query })) as {
              runs: RunState[];
            };
            for (const run of runs) {
              deps.runs.upsert(run);
              byId.set(run.id, run);
            }
          } catch (err) {
            deps.log?.(
              `Listing runs on ${engine.endpoint.container} failed: ${(err as Error).message}`,
            );
          }
        }),
      );
      const runs = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { runs };
    },
    "runs.preview": async ({ body }) =>
      deps.engines.requireProject(body.projectId).call("engine.runs.preview", { body }) as never,
    "runs.create": async ({ body, reply }) => {
      const engine = deps.engines.requireProject(body.projectId);
      const run = (await engine.call("engine.runs.create", {
        body: { ...body, runId: ulid() },
      })) as RunState;
      deps.runs.upsert(run);
      if (body.boxId !== undefined) {
        await core.boxes.message(body.boxId, HOLD_EDITS_MESSAGE).catch((err: unknown) => {
          deps.log?.(`Asking ${body.boxId} to hold edits failed: ${(err as Error).message}`);
        });
      }
      reply.code(201);
      return run;
    },
    ...runProxies,
    "usage.samples": async ({ query }) => ({ samples: deps.usage.samples(query) }),
    "usage.get": async () => ({ vendors: deps.usage.vendors() }),

    // Notifications
    "notifications.list": async ({ query }) => ({
      notifications: deps.notifications.list({ unread: query.unread }),
    }),
    "notifications.read": async ({ params }) => {
      if (!deps.notifications.markRead(params.notificationId)) {
        throw new ApiError("not_found", `No notification has the id ${params.notificationId}.`);
      }
      return { ok: true };
    },
  };
}

/** The display command of a job, for tests and logs. */
export const jobCommand = commandLine;
