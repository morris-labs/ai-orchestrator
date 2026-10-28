// The part of the server core that the services and the API use.
// `createCore()` in `src/core.ts` builds an object that satisfies `Core` over
// the core modules; the API tests use the in-memory fake in
// `test/api/fake-core.ts`.
//
// Every input and output is a contract type. A method that fails throws an
// error whose `code` property names a contract `ApiErrorCode` (for example an
// `ApiFailure` from `./errors.ts`); the API maps it to a status code.
import type {
  AgentBoxEvent,
  Box,
  BoxCreate,
  BoxView,
  ConvertToWorktreeResult,
  ConvertToWorktreePlan,
  EngineInfo,
  GlobalSettings,
  GlobalSettingsPatch,
  ImportReport,
  ImageStatus,
  Listener,
  Mount,
  Platform,
  PolicyFile,
  Project,
  ProjectSummary,
  PromptTemplates,
  SecretRef,
  SshRemote,
  BoxUpdateSchema,
  BoxRemoveResultSchema,
  BulkResultSchema,
  ConversationSummary,
  ModelsResultSchema,
  PolicyResultSchema,
  ProjectCreateSchema,
  ProjectUpdateResultSchema,
  ProjectUpdateSchema,
  PurgeResultSchema,
  BoxUpdateResultSchema,
} from "@agentbox/contracts";
import type Docker from "dockerode";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Contract types that the contracts package exports only as schemas

export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;
export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>;
export type ProjectUpdateResult = z.infer<typeof ProjectUpdateResultSchema>;
export type PolicyResult = z.infer<typeof PolicyResultSchema>;
export type BoxUpdate = z.infer<typeof BoxUpdateSchema>;
export type BoxUpdateResult = z.infer<typeof BoxUpdateResultSchema>;
export type BoxRemoveResult = z.infer<typeof BoxRemoveResultSchema>;
export type BulkResult = z.infer<typeof BulkResultSchema>;
export type PurgeResult = z.infer<typeof PurgeResultSchema>;
export type ModelsResult = z.infer<typeof ModelsResultSchema>;

// ---------------------------------------------------------------------------
// Events

/** The fields the event hub fills on every event. */
export type EventBaseKey = "id" | "time" | "source" | "streamId" | "seq" | "sourceSeq";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as a producer emits it, before the hub numbers it. */
export type EventInput = DistributiveOmit<AgentBoxEvent, EventBaseKey>;

/** Where the core sends the events it emits (`box.changed`, `container.*`, `settings.changed`). */
export interface EventSink {
  /** Numbers, stores, and broadcasts the event, and returns it as sent. */
  emit(event: EventInput): AgentBoxEvent;
}

// ---------------------------------------------------------------------------
// SQLite

/** A prepared statement: the subset of better-sqlite3 that the services use. */
export interface SqlStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** The subset of a better-sqlite3 `Database` that the services use. */
export interface SqlDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
}

// ---------------------------------------------------------------------------
// Core parts

/** Streams the output of a long-running core operation into its job terminal. */
export type JobLog = (text: string) => void;

export interface CoreProjects {
  list(): Promise<ProjectSummary[]>;
  create(input: ProjectCreate): Promise<Project>;
  /** Throws `not_found`. */
  get(projectId: string): Promise<ProjectSummary>;
  update(projectId: string, patch: ProjectUpdate): Promise<ProjectUpdateResult>;
  restartContainer(projectId: string): Promise<BulkResult>;
  getPolicy(projectId: string): Promise<PolicyResult>;
  putPolicy(projectId: string, policy: PolicyFile): Promise<PolicyResult>;
}

export interface CoreBoxes {
  list(query: { projectId?: string }): Promise<BoxView[]>;
  /** Throws `not_found`. */
  get(boxId: string): Promise<BoxView>;
  /**
   * Checks a `boxes.create` body before the job starts, so the conflicts
   * (`adoption_refused`, `session_tracked`, `secrets_*`, `image_missing`,
   * `engine_mismatch`, `stale_mounts`) answer the request itself.
   */
  validateCreate(input: BoxCreate): Promise<void>;
  /** Creates (and with `start`, starts) the box; runs inside a `box_create` job. */
  create(input: BoxCreate, log: JobLog): Promise<Box>;
  update(boxId: string, patch: BoxUpdate): Promise<BoxUpdateResult>;
  /** With `force`, starts the box although its container's mounts are stale. */
  start(boxId: string, options?: { force?: boolean }): Promise<BoxView>;
  stop(boxId: string): Promise<BoxView>;
  restart(boxId: string): Promise<BoxView>;
  remove(boxId: string, options: { removeWorktree: boolean }): Promise<BoxRemoveResult>;
  /** With `dryRun`, reports what a purge would delete and deletes nothing. */
  purge(boxId: string, options?: { dryRun?: boolean }): Promise<PurgeResult>;
  move(boxId: string, newDir: string): Promise<{ movedBoxes: string[] }>;
  relink(boxId: string, targetDir: string): Promise<BoxView>;
  /** Checks a Convert to Worktree request before the job starts (`box_running`, `conflict`). */
  validateConvertToWorktree(boxId: string): Promise<void>;
  /** Previews Convert to Worktree without changing anything (`box_running`, `conflict`). */
  planConvertToWorktree(boxId: string): Promise<ConvertToWorktreePlan>;
  convertToWorktree(
    boxId: string,
    options: { copyBuildOutput: boolean },
    log: JobLog,
  ): Promise<ConvertToWorktreeResult>;
  startSideSession(boxId: string, platform: Platform): Promise<{ session: string }>;
  stopSideSession(boxId: string, platform: Platform): Promise<void>;
  setPlatform(boxId: string, platform: Platform, restart: boolean): Promise<BoxView>;
  /** Types one message into the box's interactive session. */
  message(boxId: string, text: string): Promise<void>;
  startAll(onlyWasRunning: boolean): Promise<BulkResult>;
  stopAll(): Promise<BulkResult>;
  restartAll(): Promise<BulkResult>;
}

export interface CoreDocker {
  /** The dockerode client; terminals use it for `exec` with a TTY. */
  api: Docker;
  /** True when the daemon answers. */
  ping(): Promise<boolean>;
  /** Samples container stats now; `container.stats` events follow. */
  refreshStats(): Promise<void>;
}

export interface CoreImage {
  status(): Promise<ImageStatus>;
}

export interface CoreCatalog {
  list(dir: string): Promise<{ dir: string; conversations: ConversationSummary[] }>;
}

export interface CoreModels {
  list(dir?: string): Promise<ModelsResult>;
  /** Throws `image_missing`. */
  rescan(): Promise<ModelsResult>;
}

/**
 * The global settings in `~/.claude-box/config.json`. Every write emits
 * `settings.changed`.
 */
export interface CoreSettings {
  get(): GlobalSettings;
  /** Applies a `PATCH /api/v1/settings` body. */
  patch(patch: GlobalSettingsPatch): Promise<GlobalSettings>;
  setPromptTemplates(templates: PromptTemplates): Promise<GlobalSettings>;
  /** Host directories must exist (`validation`). Returns running containers that lack the mounts. */
  setGlobalMounts(mounts: Mount[]): Promise<{ mounts: Mount[]; staleContainers: string[] }>;
  setSecretRefs(refs: SecretRef[]): Promise<GlobalSettings>;
  completeSetup(input: { defaultTargetDir?: string }): Promise<GlobalSettings>;
}

/** The named SSH remotes. */
export interface CoreSshRemotes {
  list(): Promise<SshRemote[]>;
  /** Throws `not_found`. */
  get(name: string): Promise<SshRemote>;
  /**
   * Creates or replaces the remote stored as `name`. A different
   * `remote.name` renames it and rewrites every box's `sshRemoteRefs`; an
   * existing remote with the new name fails with `conflict`.
   */
  put(name: string, remote: SshRemote): Promise<SshRemote>;
  /** Deletes the remote and drops it from every box. */
  delete(name: string): Promise<{ unlinkedBoxes: string[] }>;
}

/** How the server reaches one project container's engine. */
export interface EngineEndpoint {
  container: string;
  projectId: string;
  /** The host loopback port Docker maps to the engine's 20411; `null` while unknown. */
  hostPort: number | null;
  /** The `AGENTBOX_ENGINE_TOKEN` the server gave the container. Never logged. */
  token: string;
}

export interface CoreEngines {
  /** The engines of every running project container. */
  list(): Promise<EngineEndpoint[]>;
}

/** The one-time import of the 3.3.5 records and settings. */
export interface CoreLegacyImport {
  /** Imports, or with `dryRun`, reports what it would import and changes nothing. */
  run(options: { dryRun: boolean }): Promise<ImportReport>;
}

export interface Core {
  db: SqlDatabase;
  docker: CoreDocker;
  image: CoreImage;
  projects: CoreProjects;
  boxes: CoreBoxes;
  catalog: CoreCatalog;
  models: CoreModels;
  settings: CoreSettings;
  sshRemotes: CoreSshRemotes;
  engines: CoreEngines;
  legacyImport: CoreLegacyImport;
}

/**
 * Services the server builds before the core and hands to it: the event
 * sink, the secret resolver for launches, the active runs that make a box
 * `under_review`, and what the engines report. The core calls them lazily,
 * so they may depend on objects built after the core.
 */
export interface CoreServices {
  events: EventSink;
  /** Resolves the global and project secret references into environment variables. */
  resolveSecrets(projectId: string): Promise<Record<string, string>>;
  /** The active run that holds a box's working tree, or `null`. */
  activeRunForBox(boxId: string): string | null;
  /** The listeners the engine in `container` last reported. Default: none. */
  listeners?(container: string): Listener[];
  /** The engine in `container` as the server last saw it, or `null`. */
  engineInfo?(container: string): EngineInfo | null;
}

export interface CoreFactoryOptions {
  /** The host user's home directory; every `~` path resolves against it. */
  home: string;
  services: CoreServices;
  /** The engine version this server expects in the image and in each container. */
  engineVersion: string;
  /** The image build context, the repository's `image/` directory. */
  imageContext: string;
  log?(message: string): void;
}

/** The signature of `createCore` in `src/core.ts`. */
export type CoreFactory = (
  options: CoreFactoryOptions,
) => Promise<Core & { close?(): Promise<void> }>;
