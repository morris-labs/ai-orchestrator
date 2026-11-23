// One handler per engine HTTP route. The table in `@aio/contracts`
// decides which handlers must exist; `server.ts` validates inputs and outputs.
import type { EngineRouteKey, EngineRoutes, Listener } from "@aio/contracts";
import type { z } from "zod";
import type { BuildManager } from "../build/manager.js";
import { EngineError, type RunManager } from "./core-interface.js";
import type { RepoInfo, RepoRefs } from "./repos.js";

/** The engine routes served by an ordinary HTTP handler. */
export type EngineHttpKey = {
  [K in EngineRouteKey]: EngineRoutes[K] extends { kind: "http" } ? K : never;
}[EngineRouteKey];

type Out<T> = T extends z.ZodTypeAny ? z.infer<T> : undefined;

/** What a handler receives, after validation. */
export interface HandlerInput<K extends EngineHttpKey> {
  params: Record<string, string>;
  query: EngineRoutes[K] extends { query: infer Q } ? Out<Q> : undefined;
  body: EngineRoutes[K] extends { body: infer B } ? Out<B> : undefined;
}

export type HandlerOutput<K extends EngineHttpKey> = EngineRoutes[K] extends {
  response: infer R;
}
  ? z.input<R & z.ZodTypeAny>
  : never;

export type Handler<K extends EngineHttpKey> = (
  input: HandlerInput<K>,
) => Promise<HandlerOutput<K>> | HandlerOutput<K>;

export type EngineHandlers = { [K in EngineHttpKey]: Handler<K> };

export interface HealthInfo {
  version: string;
  uptimeS: number;
  engineVersion: string;
  container: string;
  projectRoot: string;
  streamId: string;
  /** Whether `engineVersion` equals the version the server expects. */
  versionMatches: boolean;
}

export interface HandlerDeps {
  runs: RunManager;
  builds: BuildManager;
  repos: { list(): Promise<RepoInfo[]>; refs(repo: string, fetch?: boolean): Promise<RepoRefs> };
  ports: { list(): Listener[] };
  health: () => HealthInfo;
}

async function found<T>(runId: string, value: Promise<T | null>, what = "run"): Promise<T> {
  const v = await value;
  if (v === null) {
    throw new EngineError(what === "run" ? "run_not_found" : "not_found", `No ${what} ${runId}.`);
  }
  return v;
}

function param(input: { params: Record<string, string> }, name: string): string {
  const v = input.params[name];
  if (v === undefined) throw new EngineError("validation", `Missing path parameter ${name}.`);
  return v;
}

/** Builds the handler for every engine HTTP route. */
export function createHandlers(deps: HandlerDeps): EngineHandlers {
  const { runs } = deps;
  const run = (i: { params: Record<string, string> }) => param(i, "runId");
  return {
    "engine.health": () => deps.health(),
    "engine.repos.list": async () => ({ repos: await deps.repos.list() }),
    "engine.repos.refs": (i) => deps.repos.refs(i.query.repo, i.query.fetch === "true"),
    "engine.runs.list": async (i) => ({ runs: await runs.list(i.query) }),
    "engine.runs.preview": (i) => runs.preview(i.body),
    "engine.runs.create": (i) => runs.start(i.body),
    "engine.runs.get": (i) => found(run(i), runs.get(run(i))),
    "engine.runs.pause": (i) => runs.pause(run(i)),
    "engine.runs.resume": (i) => runs.resume(run(i)),
    "engine.runs.cancel": (i) => runs.cancel(run(i)),
    "engine.runs.profile": (i) => runs.profile(run(i), i.body.profile),
    "engine.runs.assign": (i) => runs.assign(run(i), i.body.role, i.body.vendors),
    "engine.runs.rebaseBase": (i) => runs.rebaseBase(run(i)),
    "engine.runs.retry": (i) => runs.retry(run(i), i.body),
    "engine.runs.decide": (i) => runs.decide(run(i), i.body),
    "engine.runs.push": (i) => runs.push(run(i), i.body),
    "engine.runs.groups": async (i) => ({ groups: await runs.groups(run(i)) }),
    "engine.runs.rounds": async (i) => ({ rounds: await runs.rounds(run(i)) }),
    "engine.findings.list": async (i) => ({ findings: await runs.findings(run(i), i.query) }),
    "engine.findings.get": async (i) => {
      const id = param(i, "findingId");
      await found(run(i), runs.get(run(i)));
      return found(id, runs.finding(run(i), id), "finding");
    },
    "engine.findings.waive": (i) => runs.waive(run(i), param(i, "findingId"), i.body.reason),
    "engine.usage.samples": async (i) => ({ samples: await runs.usageSamples(i.query) }),
    "engine.builds.create": (i) => deps.builds.start(i.body),
    "engine.builds.get": async (i) => {
      const slug = param(i, "slug");
      return found(slug, deps.builds.get(slug), "build");
    },
    "engine.builds.pause": (i) => deps.builds.pause(param(i, "slug"), i.body.reason),
    "engine.builds.resume": (i) => deps.builds.resume(param(i, "slug"), i.body.reason),
    "engine.builds.cancel": (i) => deps.builds.cancel(param(i, "slug")),
    "engine.builds.delete": (i) => deps.builds.delete(param(i, "slug")),
    "engine.builds.resolve": (i) => deps.builds.resolve(param(i, "slug"), i.body),
    "engine.builds.post": (i) => deps.builds.post(param(i, "slug"), i.body),
    "engine.builds.inbox": (i) =>
      deps.builds.inbox(param(i, "slug"), { all: i.query.all ?? false }),
    "engine.builds.inbox.delivered": (i) =>
      deps.builds.delivered(param(i, "slug"), param(i, "itemId")),
    "engine.ports": () => ({ listeners: deps.ports.list() }),
  };
}
