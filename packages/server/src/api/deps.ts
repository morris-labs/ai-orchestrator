// What the API layer needs, as narrow interfaces, so route tests can pass
// fakes for the services as well as for the core.
import type {
  AioEvent,
  EngineRouteKey,
  EventType,
  Job,
  BuildUsage,
  Notification,
  Finding,
  RunState,
  SetupCheck,
  TimedUsageSample,
  Updates,
  Vendor,
  SecretsAvailable,
  SecretsCheckResultSchema,
  SecretsViewSchema,
  SetupStatusSchema,
  SshTestResultSchema,
  VendorUsageSchema,
  SshRemote,
  ImageBuildSchema,
  EnrollmentCode,
  GuiClientList,
  Machine,
  MachineHealth,
  NodeJoin,
  NodeStatus,
} from "@aio/contracts";
import type { z } from "zod";
import type { Core, EventInput } from "./core-interface.js";
import type { EngineCallInput } from "../events/engine-client.js";
import type { ReplayPlan } from "../events/hub.js";
import type { JobManager } from "../jobs/jobs.js";
import type { ExecBackend } from "../terminals/exec.js";
import type { DevServerProxy } from "../proxy/proxy.js";
import type { LinkRegistry } from "../hub/link.js";
import type { UpgradeService } from "../setup/upgrade.js";
import type { MachineRoutingOptions } from "./machines.js";

/** Multi-host as the machine and node routes use it. */
export interface ApiMultiHost {
  machines(): Promise<Machine[]>;
  enroll(): Promise<EnrollmentCode>;
  revoke(id: string): Promise<void>;
  guiClients(): GuiClientList;
  enrollGui(): Promise<EnrollmentCode>;
  revokeGui(id: string): Promise<void>;
  status(): NodeStatus;
  /** This machine's health, which the hub shows on the Machines page. */
  health(): Promise<MachineHealth>;
  join(input: NodeJoin): Promise<NodeStatus>;
}

/** One engine, as the API uses it. */
export interface ApiEngine {
  endpoint: { container: string; projectId: string };
  assertVersion(): void;
  /** Like `assertVersion`, but checks the engine's health first when its version is unknown. */
  confirmVersion(): Promise<void>;
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
  /** The `seq` of the newest event in the unfiltered stream. */
  readonly lastSeq: number;
  emit(event: EventInput): AioEvent;
  subscribe(listener: (event: AioEvent) => void): () => void;
  /** With `filter`, plans the stream of those event types only; see `EventHub.replay`. */
  replay(
    hello: { type: "hello"; streamId: string | null; lastSeq: number | null },
    filter?: ReadonlySet<EventType> | null,
  ): ReplayPlan;
}

export interface ApiRuns {
  upsert(run: RunState): void;
  /** Why `run` doesn't belong to the engine at `endpoint`, or `null` when it does. */
  foreignReason(endpoint: ApiEngine["endpoint"], run: RunState): string | null;
  get(runId: string): RunState | undefined;
  findings?(runId: string): Finding[];
  list(query: { projectId?: string; boxId?: string; status?: RunState["status"] }): RunState[];
}

export interface ApiDeps {
  core: Core;
  /** The host user's home directory; `fs.dirs` lists it when no path is given. */
  home: string;
  token: string;
  version: string;
  startedAt: Date;
  hub: ApiHub;
  jobs: JobManager;
  runs: ApiRuns;
  engines: ApiEngines;
  usage: {
    vendors(): z.infer<typeof VendorUsageSchema>[];
    clear(vendor: Vendor, account?: string): Promise<number>;
    samples(query: { vendor?: Vendor; since?: string; until?: string }): TimedUsageSample[];
    forgetAccount?(vendor: Vendor, account: string): void;
  };
  builds: {
    /** One build's settled usage, or `undefined` for a build the server hasn't seen. */
    usage(buildId: string): BuildUsage | undefined;
  };
  notifications: {
    list(query: { unread?: boolean }): Notification[];
    markRead(id: string): boolean;
  };
  secrets: {
    view(): Promise<z.infer<typeof SecretsViewSchema>>;
    check(projectId?: string): Promise<z.infer<typeof SecretsCheckResultSchema>>;
    available(refresh: boolean): Promise<SecretsAvailable>;
  };
  upgrade?: UpgradeService;
  upgradeBuildJob?: () => string | null;
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
  /**
   * Links to other machines: the connected nodes on a hub, or the hub on a
   * plain node. Absent on a single-PC install, where only `local` resolves.
   */
  links?: LinkRegistry;
  /**
   * The role, own machine ID and timeouts of the machine proxy route; see
   * `startApp`.
   */
  machines?: MachineRoutingOptions;
  /** The machine list, enrollment, revocation, and joining a hub. */
  multiHost?: ApiMultiHost;
  /** Directories of the built single-page apps, served when present. */
  staticDirs?: { boxes?: string; review?: string };
  log?: (message: string) => void;
}
