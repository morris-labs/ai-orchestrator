// What the API layer needs, as narrow interfaces, so route tests can pass
// fakes for the services as well as for the core.
import type {
  AgentBoxEvent,
  EngineRouteKey,
  Job,
  Notification,
  RunState,
  SetupCheck,
  TimedUsageSample,
  Updates,
  Vendor,
  SecretsCheckResultSchema,
  SecretsViewSchema,
  SetupStatusSchema,
  SshTestResultSchema,
  VendorUsageSchema,
  SshRemote,
  ImageBuildSchema,
} from "@agentbox/contracts";
import type { z } from "zod";
import type { Core, EventInput } from "./core-interface.js";
import type { EngineCallInput } from "../events/engine-client.js";
import type { ReplayPlan } from "../events/hub.js";
import type { JobManager } from "../jobs/jobs.js";
import type { ExecBackend } from "../terminals/exec.js";
import type { DevServerProxy } from "../proxy/proxy.js";

/** One engine, as the API uses it. */
export interface ApiEngine {
  endpoint: { container: string; projectId: string };
  assertVersion(): void;
  call(key: EngineRouteKey, input?: EngineCallInput): Promise<unknown>;
}

export interface ApiEngines {
  get(container: string): ApiEngine | undefined;
  all(): ApiEngine[];
  forProject(projectId: string): ApiEngine | undefined;
  requireProject(projectId: string): ApiEngine;
}

export interface ApiHub {
  readonly streamId: string;
  emit(event: EventInput): AgentBoxEvent;
  subscribe(listener: (event: AgentBoxEvent) => void): () => void;
  replay(hello: { type: "hello"; streamId: string | null; lastSeq: number | null }): ReplayPlan;
}

export interface ApiRuns {
  upsert(run: RunState): void;
  get(runId: string): RunState | undefined;
  list(query: { projectId?: string; boxId?: string; status?: RunState["status"] }): RunState[];
}

export interface ApiDeps {
  core: Core;
  token: string;
  version: string;
  startedAt: Date;
  hub: ApiHub;
  jobs: JobManager;
  runs: ApiRuns;
  engines: ApiEngines;
  usage: {
    vendors(): z.infer<typeof VendorUsageSchema>[];
    samples(query: { vendor?: Vendor; since?: string; until?: string }): TimedUsageSample[];
  };
  notifications: {
    list(query: { unread?: boolean }): Notification[];
    markRead(id: string): boolean;
  };
  secrets: {
    view(): Promise<z.infer<typeof SecretsViewSchema>>;
    check(projectId?: string): Promise<z.infer<typeof SecretsCheckResultSchema>>;
  };
  setup: {
    status(): Promise<z.infer<typeof SetupStatusSchema>>;
    fix(checkId: SetupCheck["id"] | string): Job;
    buildImage(kind: z.infer<typeof ImageBuildSchema>["kind"]): Job;
  };
  updates: { check(force: boolean): Promise<Updates> };
  ssh: {
    status(name: string): { tunnelUp: boolean; tunnelError: string | null };
    reconnect(name: string): Promise<void>;
    test(remote: SshRemote): Promise<z.infer<typeof SshTestResultSchema>>;
    copyId(remote: SshRemote): Job;
  };
  exec: ExecBackend;
  proxy?: DevServerProxy;
  /** Directories of the built single-page apps, served when present. */
  staticDirs?: { boxes?: string; review?: string };
  log?: (message: string) => void;
}
