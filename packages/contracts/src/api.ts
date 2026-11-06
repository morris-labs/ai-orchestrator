// The route catalog for the server API and the engine API.
//
// Each route is a plain data entry: method, path, and the zod schemas for its
// query, body, and response (or, for a WebSocket route, its client and server
// frames). The server and the engine register their Fastify handlers by
// iterating the tables, and thin clients (the apps, the CLI) build requests
// from the same entries, so both sides stay in step.
//
// Authentication:
//
// - Server, REST. The server listens on `127.0.0.1:21400`. Every route with
//   `auth: true` accepts either `Authorization: Bearer <token>`, where the
//   token is the content of `~/.ai-orchestrator/server.token`, or the
//   `aio_session` cookie. `POST /api/v1/auth/session` (`auth.session`)
//   sets that cookie (HttpOnly, SameSite=Strict, Path=/) when called with the
//   bearer header. The Electron apps receive the token from their preload
//   script and send the header; a plain browser opening the single-page apps
//   uses the cookie.
// - WebSocket routes (`kind: "ws"`) authenticate the upgrade request the
//   same way: `Authorization: Bearer <token>` from a client that can set
//   headers (the CLI, the Electron main processes), or the session cookie
//   from a browser renderer. No API accepts a token in the query string, so
//   tokens stay out of URLs and logs.
// - Dev-server proxy. Requests to `http://<port>.<hostKey>.localhost:<proxy
//   port>/` need no authentication: the listener is bound to loopback only.
// - Engine. The engine listens on `0.0.0.0:20411` inside its container, and
//   every route with `auth: true`, WebSocket upgrades included, needs
//   `Authorization: Bearer <engine token>`. Only the server calls it. The
//   engine's `/proxy` route takes the token in `X-Aio-Engine-Token`
//   instead, so the browser's own `Authorization` header reaches the app.
//
// Other conventions:
//
// - Path parameters are written `:name` and are always strings; use
//   `buildPath()` to fill them and `pathParamNames()` to list them.
// - Query values arrive as strings, so query schemas coerce them.
// - A failed call returns a 4xx or 5xx status code with an `ApiError` body.
//   `errors` on a route lists the codes specific to it; `validation`,
//   `not_found`, `docker_unavailable`, `internal`, and, on routes with
//   `auth: true`, `unauthorized` can come from any route.
// - Responses use `null` for a missing value; stored records (`Box`,
//   `Project`, `RunState`, `Finding`) keep optional fields absent.
// - Run, finding, and round routes on the server proxy to the engine of the
//   run's project container and return the engine's bodies unchanged.
//   `usage.samples` on the server answers from the server's SQLite mirror,
//   across every engine, instead.
// - Every server route also answers under `/api/v1/machines/ID/proxy`,
//   which sends the call to machine `ID`; `local` means the server itself.
//   See `machine-routing.ts`.
// - Terminal and job streams carry terminal bytes as binary frames in both
//   directions and control messages as JSON text frames. Event streams carry
//   only JSON text frames. The `clientMessage` and `serverMessage` schemas
//   describe the JSON frames.
import { z } from "zod";
import {
  AccountCreateSchema,
  AccountImportRequestSchema,
  AccountImportResultSchema,
  AccountRemoveResultSchema,
  AccountSeedRequestSchema,
  AccountUpdateSchema,
  AccountRelinkResultSchema,
  TranscriptsAdoptRequestSchema,
  TranscriptsAdoptResultSchema,
  AccountViewSchema,
} from "./accounts.js";
import {
  ApiErrorSchema,
  CommitShaSchema,
  AccountIdSchema,
  EffortSchema,
  EnvVarNameSchema,
  IsoDateTimeSchema,
  OkSchema,
  PlatformSchema,
  PortSchema,
  RunIdSchema,
  VendorSchema,
  type ApiErrorCode,
} from "./common.js";
import {
  BoxStatusSchema,
  ClientHelloSchema,
  ContainerStateSchema,
  EngineInfoSchema,
  EngineStreamClientFrameSchema,
  EngineStreamFrameSchema,
  ListenerSchema,
  NotificationSchema,
  ServerStreamFrameSchema,
  UsageSampleSchema,
  UsageWindowSchema,
} from "./events.js";
import { FindingSchema, SeveritySchema, VerdictSchema } from "./findings.js";
import {
  EnrollmentCodeSchema,
  GuiClientListSchema,
  MachineHealthSchema,
  MachineListSchema,
  MachineRoleSchema,
} from "./machines.js";
import { PolicyFileSchema } from "./policy.js";
import {
  BoxSchema,
  CeilingSchema,
  CeilingsOverrideSchema,
  GlobalSettingsPatchSchema,
  GlobalSettingsSchema,
  EnrollMachineNameSchema,
  MountSchema,
  OpReferenceSchema,
  ProjectSchema,
  PromptTemplatesSchema,
  SecretRefSchema,
  SshRemoteInputSchema,
  SshRemoteSchema,
  TcpMapSchema,
  BoxAccountsPatchSchema,
  BoxAccountsSchema,
} from "./records.js";
import {
  DecisionAnswerSchema,
  EngineRunCreateSchema,
  EngineRunPreviewSchema,
  FileGroupSchema,
  ProfileSchema,
  RoleSchema,
  RoundSummarySchema,
  RunRequestSchema,
  RunRetrySchema,
  RunStateSchema,
  RunStatusSchema,
} from "./runs.js";

// ---------------------------------------------------------------------------
// Route definition types

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RouteBase {
  path: string;
  summary: string;
  /** False only for health checks. */
  auth: boolean;
  /** Error codes specific to this route. */
  errors?: readonly ApiErrorCode[];
}

export interface HttpRouteDef extends RouteBase {
  kind: "http";
  method: HttpMethod;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  response: z.ZodTypeAny;
  /** The success status code; 200 when absent. */
  status?: number;
}

export interface WsRouteDef extends RouteBase {
  kind: "ws";
  method: "GET";
  query?: z.ZodTypeAny;
  /** JSON text frames the client sends. */
  clientMessage: z.ZodTypeAny;
  /** JSON text frames the server sends. */
  serverMessage: z.ZodTypeAny;
}

/** A pass-through route: any method, no body schema. */
export interface ProxyRouteDef extends RouteBase {
  kind: "proxy";
  method: "ALL";
}

export type RouteDef = HttpRouteDef | WsRouteDef | ProxyRouteDef;

function http<const R extends Omit<HttpRouteDef, "kind" | "auth"> & { auth?: boolean }>(
  route: R,
): R & { kind: "http"; auth: boolean } {
  return { ...route, kind: "http", auth: route.auth ?? true };
}

function ws<const R extends Omit<WsRouteDef, "kind" | "auth" | "method"> & { auth?: boolean }>(
  route: R,
): R & { kind: "ws"; method: "GET"; auth: boolean } {
  return { ...route, kind: "ws", method: "GET", auth: route.auth ?? true };
}

// ---------------------------------------------------------------------------
// Query helpers

/** A query-string boolean: `true` or `false`. (`z.coerce.boolean` reads "false" as true.) */
export const QueryBooleanSchema = z.enum(["true", "false"]).transform((v) => v === "true");
const queryInt = z.coerce.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Shared payloads

const V1 = "/api/v1";

/** Whether a run holds a box's working tree. Derived from the active runs, not stored. */
export const ReviewStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }),
  z.object({ state: z.literal("under_review"), runId: RunIdSchema }),
]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/**
 * A long-running host command, such as an image build or a box creation.
 * `jobs.stream` streams its terminal output, and `jobs.get` returns its state.
 */
export const JobSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "image_build",
    "setup_fix",
    "ssh_copy_id",
    "box_create",
    "convert_to_worktree",
    "account_seed",
  ]),
  /** The box the job creates or changes, or `null`. */
  boxId: z.string().min(1).nullable(),
  /** The command as a person would type it, for the "Running: ..." label. */
  command: z.string(),
  status: z.enum(["running", "finished", "failed"]),
  exitCode: z.number().int().nullable(),
  /** Why the job failed, or `null`. */
  error: ApiErrorSchema.shape.error.nullable(),
  /**
   * The job's result once it finishes, or `null`: a `ConvertToWorktreeResult`
   * for `convert_to_worktree`, `{ box }` for `box_create`, an
   * `AccountSeedReport` for `account_seed`.
   */
  result: z.unknown().nullable(),
  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),
});
export type Job = z.infer<typeof JobSchema>;

export const ContainerInfoSchema = z.object({
  name: z.string().min(1),
  state: ContainerStateSchema,
  engine: EngineInfoSchema.nullable(),
  /**
   * How a running container differs from what the project asks for, such
   * as `secrets environment -> broker` or `image -> rebuilt`; a restart
   * applies the project's settings and the configured image. Empty or absent when it matches or isn't running.
   */
  stale: z.array(z.string()).optional(),
});
export type ContainerInfo = z.infer<typeof ContainerInfoSchema>;

export const ProjectSummarySchema = z.object({
  project: ProjectSchema,
  running: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  container: ContainerInfoSchema.nullable(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const ProjectCreateSchema = z.object({
  root: z.string().min(1),
  name: z.string().min(1).optional(),
});

/** Fields to change. `ceilingsOverride: null` removes the override. */
export const ProjectUpdateSchema = z.object({
  name: z.string().optional(),
  primaryRepo: z.string().min(1).nullable().optional(),
  tcpMaps: z.array(TcpMapSchema).optional(),
  mounts: z.array(MountSchema).optional(),
  secretRefs: z.array(SecretRefSchema).optional(),
  ceilingsOverride: CeilingsOverrideSchema.nullable().optional(),
  policyPath: z.string().min(1).optional(),
});

export const ProjectUpdateResultSchema = z.object({
  project: ProjectSchema,
  /** Running boxes that keep the old mounts, ports, or secrets until their container restarts. */
  staleBoxes: z.array(z.string()),
});

export const PolicyResultSchema = z.object({
  /** Absolute host path of the policy file. */
  path: z.string().min(1),
  exists: z.boolean(),
  policy: PolicyFileSchema,
  /**
   * The file's text, comments included, or `null` when the file doesn't
   * exist. An editor that saves this text back keeps the comments.
   */
  text: z.string().nullable().optional(),
  /**
   * Identifies the file's content. Pass it as `baseRevision` on a put so the
   * put fails with `conflict` when the file changed since it was read.
   */
  revision: z.string().min(1).optional(),
});

/** A put of the policy file's text as written, comments included. */
export const PolicyTextSchema = z.object({ text: z.string() }).strict();

/**
 * The `projects.policy.put` body: the policy as an object, which the server
 * writes as YAML without comments, or the file's text, which it validates
 * and writes as it is.
 */
export const PolicyPutSchema = z.union([PolicyFileSchema, PolicyTextSchema]);
export type PolicyPut = z.infer<typeof PolicyPutSchema>;

export const BoxStatsSchema = z.object({
  cpuPercent: z.number().nonnegative(),
  memBytes: z.number().int().nonnegative(),
  memLimitBytes: z.number().int().nonnegative(),
});

/** A box as the apps show it: the record plus live and derived state. */
export const BoxViewSchema = z.object({
  box: BoxSchema,
  status: BoxStatusSchema,
  /** The container the box's session runs in. */
  container: z.string().min(1),
  /** The tmux session to attach to. */
  tmuxSession: z.string().min(1),
  reviewState: ReviewStateSchema,
  /** Container stats, shared by every box in the container; `null` until sampled. */
  stats: BoxStatsSchema.nullable(),
  listeners: z.array(ListenerSchema),
  /** Proxy links for dev servers, `http://<port>.<hostKey>.localhost:21400/`. */
  proxyUrls: z.array(z.object({ port: PortSchema, url: z.string().url() })),
  /** Platforms running as side sessions next to the main one. */
  sideSessions: z.array(PlatformSchema),
  /** False when `box.targetDir` is missing on the host, such as after a manual move. */
  targetDirExists: z.boolean(),
  /**
   * The directory the box's session works in, as its container sees it: the
   * worktree or target directory through the host-to-container path mapping.
   * The same as the host path on Linux and macOS; `/mnt/host/c/...` on
   * Windows. Absent from older servers, and when the path can't be mapped.
   */
  containerWorkDir: z.string().min(1).optional(),
});
export type BoxView = z.infer<typeof BoxViewSchema>;

/** How a new box gets its conversation. */
export const ConversationModeSchema = z.discriminatedUnion("mode", [
  /** Mint a session id and start an empty conversation. */
  z.object({ mode: z.literal("new") }),
  /** Resume an existing transcript; skips provisioning. */
  z.object({ mode: z.literal("adopt"), sessionUuid: z.string().uuid() }),
  /** Copy another box's conversation into a new session (`--fork-session`). */
  z.object({ mode: z.literal("fork"), fromBoxId: z.string().min(1) }),
]);
export type ConversationMode = z.infer<typeof ConversationModeSchema>;

/**
 * The body of `boxes.create`.
 *
 * - `layout` is required. `auto` applies `GlobalSettings.newBoxDefaults` for
 *   the target directory, as 3.3.5 did; `rememberLayout` stores the resolved
 *   choice there for next time.
 * - Platforms other than `claude` take no `model` or `effort` and only a
 *   `new` conversation.
 * - `worktree` and `workspace` need a conversation name, because the slug
 *   names the folder and the branch.
 * - Adopting a session that a stopped box holds fails with 409
 *   `session_tracked` (holder box ids in `details.holders`) unless `force`
 *   is true. A running holder always fails with `adoption_refused`.
 */
export const BoxCreateSchema = z
  .object({
    targetDir: z.string().min(1),
    platform: PlatformSchema.default("claude"),
    conversationName: z.string().default(""),
    conversation: ConversationModeSchema.default({ mode: "new" }),
    /** Absent leaves the choice to the settings files. */
    model: z.string().min(1).optional(),
    effort: EffortSchema.optional(),
    skipPermissions: z.boolean().default(true),
    /** The account of each vendor for this box; absent leaves the defaults. */
    accounts: BoxAccountsSchema.optional(),
    layout: z.enum(["worktree", "workspace", "root", "auto"]),
    rememberLayout: z.boolean().default(false),
    sshRemoteRefs: z.array(z.string().min(1)).default([]),
    /** False saves the record without starting it. */
    start: z.boolean().default(true),
    force: z.boolean().default(false),
  })
  .superRefine((b, ctx) => {
    if (b.platform !== "claude") {
      for (const key of ["model", "effort"] as const) {
        if (b[key] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${b.platform} boxes take no ${key}`,
          });
        }
      }
      if (b.conversation.mode !== "new") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conversation"],
          message: `${b.platform} boxes start a new conversation only`,
        });
      }
    }
    if ((b.layout === "worktree" || b.layout === "workspace") && b.conversationName.trim() === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["conversationName"],
        message: `a ${b.layout} needs a conversation name`,
      });
    }
  });
export type BoxCreate = z.infer<typeof BoxCreateSchema>;

/**
 * Fields to change. `null` for `model` or `effort` leaves it to the settings
 * files; `null` for `sessionUuid` starts a new conversation on the next start.
 * Relinking to a session another box holds follows the `boxes.create` rules,
 * including `force`.
 */
export const BoxUpdateSchema = z.object({
  conversationName: z.string().optional(),
  model: z.string().min(1).nullable().optional(),
  effort: EffortSchema.nullable().optional(),
  skipPermissions: z.boolean().optional(),
  /** Only the vendors it names change; `null` clears one. A restart applies it. */
  accounts: BoxAccountsPatchSchema.optional(),
  sessionUuid: z.string().uuid().nullable().optional(),
  sshRemoteRefs: z.array(z.string().min(1)).optional(),
  force: z.boolean().optional(),
});

export const BoxUpdateResultSchema = z.object({
  box: BoxViewSchema,
  /** True when a running box keeps the old settings until it restarts. */
  restartRequired: z.boolean(),
});

export const BoxRemoveResultSchema = z.object({
  removed: z.boolean(),
  /** What happened to the box's worktree; `none` when it has none. */
  worktree: z.enum(["removed", "kept", "refused", "none"]),
  /** Why the worktree was refused, or `null`. */
  reason: z.string().nullable(),
});

export const BulkResultSchema = z.object({
  done: z.array(z.string()),
  failed: z.array(z.object({ boxId: z.string(), error: ApiErrorSchema.shape.error })),
});

/** The body of `boxes.purge`. `dryRun` reports what a purge would remove and removes nothing. */
export const PurgeRequestSchema = z.object({ dryRun: z.boolean().default(false) }).default({});

/** What a purge removed, or with `dryRun`, what it would remove. */
export const PurgeResultSchema = z.object({
  dryRun: z.boolean(),
  /** Box ids whose records were, or would be, deleted. */
  removedRecords: z.array(z.string()),
  /** Transcript directories under `~/.claude/projects/` that were, or would be, deleted. */
  removedTranscriptDirs: z.array(z.string()),
});
export type PurgeResult = z.infer<typeof PurgeResultSchema>;

/** The body of `boxes.start`. `force` starts the box although its container's mounts are stale. */
export const BoxStartSchema = z.object({ force: z.boolean().default(false) }).default({});

/** The `result` of a `convert_to_worktree` job. */
export const ConvertToWorktreeResultSchema = z.object({
  box: BoxSchema,
  worktree: z.string().min(1),
  branch: z.string().min(1),
  /** The old folder, renamed to `<slug>.pre-worktree`. */
  oldFolder: z.string().min(1),
  recordBackup: z.string().min(1),
  /** `claude-keep/<slug>/...` branches and tags made for the clone's other refs. */
  keptRefs: z.array(z.string()),
  /** What the migration could not carry over, such as the clone's hooks. */
  notCarried: z.array(z.string()),
});
export type ConvertToWorktreeResult = z.infer<typeof ConvertToWorktreeResultSchema>;

/** A preview of Convert to Worktree; it changes nothing. */
export const ConvertToWorktreePlanSchema = z.object({
  /** What the conversion would do and what it can't carry over, for a person to read. */
  report: z.string(),
  /** Size of the clone's build output, which the conversion copies only on request. */
  buildOutputBytes: z.number().int().nonnegative(),
});
export type ConvertToWorktreePlan = z.infer<typeof ConvertToWorktreePlanSchema>;

/** The terminal kinds: a box's main session, a side session, or a shell. */
export const TerminalKindSchema = z.enum(["session", "side", "shell"]);

function checkTerminalTarget(
  q: { kind: "session" | "side" | "shell"; boxId?: string; projectId?: string; platform?: string },
  ctx: z.RefinementCtx,
) {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (q.kind !== "shell" && q.boxId === undefined)
    issue("boxId", `a ${q.kind} terminal needs a boxId`);
  if (q.kind === "shell" && q.boxId === undefined && q.projectId === undefined) {
    issue("projectId", "a shell needs a boxId or a projectId");
  }
  if (q.kind === "side" && q.platform === undefined)
    issue("platform", "a side terminal needs a platform");
  if (q.kind !== "side" && q.platform !== undefined)
    issue("platform", "only a side terminal takes a platform");
}

export const TerminalQuerySchema = z
  .object({
    kind: TerminalKindSchema,
    /** Required for `session` and `side`. */
    boxId: z.string().min(1).optional(),
    /** For `shell` when `boxId` is absent: a shell in the project's container. */
    projectId: z.string().min(1).optional(),
    /** Required for `side`, refused otherwise. */
    platform: PlatformSchema.optional(),
    cols: z.coerce.number().int().positive().default(80),
    rows: z.coerce.number().int().positive().default(24),
  })
  .superRefine(checkTerminalTarget);

export const AttachCommandQuerySchema = z
  .object({ kind: TerminalKindSchema, platform: PlatformSchema.optional() })
  .superRefine((q, ctx) => checkTerminalTarget({ ...q, boxId: "-" }, ctx));

export const TerminalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  /** Text input, as an alternative to a binary frame. */
  z.object({ type: z.literal("input"), data: z.string() }),
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessageSchema>;

export const TerminalServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), terminalId: z.string().min(1) }),
  z.object({ type: z.literal("exit"), exitCode: z.number().int().nullable() }),
  z.object({ type: z.literal("error"), error: ApiErrorSchema.shape.error }),
]);
export type TerminalServerMessage = z.infer<typeof TerminalServerMessageSchema>;

export const ConversationSummarySchema = z.object({
  sessionUuid: z.string().uuid(),
  title: z.string(),
  titleSource: z.enum(["custom-title", "ai-title", "prompt", "none"]),
  turns: z.number().int().nonnegative(),
  modifiedAt: IsoDateTimeSchema,
  sizeBytes: z.number().int().nonnegative(),
  lastPrompt: z.string(),
  /** Boxes whose record points at this session. */
  trackedBy: z.array(z.string()),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ModelsResultSchema = z.object({
  models: z.array(z.string().min(1)),
  efforts: z.array(EffortSchema),
  /** What claude would use in the directory, from its settings files. */
  defaults: z.object({ model: z.string().min(1), effort: EffortSchema }),
  source: z.enum(["scan", "cache", "baseline"]),
});

export const ImageStatusSchema = z.object({
  name: z.string().min(1),
  exists: z.boolean(),
  imageId: z.string().nullable(),
  createdAt: IsoDateTimeSchema.nullable(),
  /** From `/etc/aio-engine-version` in the image. */
  engineVersion: z.string().nullable(),
  expectedEngineVersion: z.string().min(1),
  engineMatches: z.boolean(),
  cliVersions: z.object({
    claude: z.string().nullable(),
    codex: z.string().nullable(),
    copilot: z.string().nullable(),
  }),
});
export type ImageStatus = z.infer<typeof ImageStatusSchema>;

export const ImageBuildSchema = z.object({
  /** `rebuild`: `--no-cache --pull`; `packages` and `claude-code` bust one cache layer. */
  kind: z.enum(["rebuild", "packages", "claude-code"]),
});

/** The result of `updates.check`: this app's release and the image's Claude Code. */
export const UpdatesSchema = z.object({
  checkedAt: IsoDateTimeSchema,
  app: z.object({
    current: z.string().min(1),
    latest: z.string().nullable(),
    updateAvailable: z.boolean(),
    releaseUrl: z.string().url().nullable(),
  }),
  claudeCode: z.object({
    /** The version in the engine image, or `null` when there is no image. */
    image: z.string().nullable(),
    latest: z.string().nullable(),
    /** True when the image is older than `latest`; `image.build` with `claude-code` updates it. */
    stale: z.boolean(),
  }),
});
export type Updates = z.infer<typeof UpdatesSchema>;

export const SetupCheckSchema = z.object({
  id: z.enum([
    "docker",
    "image",
    "engine",
    "ssh_client",
    "ssh_key",
    "ssh_permissions",
    "op",
    "sudo",
    "service",
  ]),
  status: z.enum(["ok", "warn", "fail"]),
  message: z.string(),
  /** True when `POST /api/v1/setup/checks/:checkId/fix` can fix it. */
  fixable: z.boolean(),
});
export type SetupCheck = z.infer<typeof SetupCheckSchema>;

export const SetupStatusSchema = z.object({
  completed: z.boolean(),
  defaultTargetDir: z.string().nullable(),
  checks: z.array(SetupCheckSchema),
});

export const PromptsResultSchema = z.object({
  templates: PromptTemplatesSchema,
  /** The built-in defaults, for Reset to default. */
  defaults: PromptTemplatesSchema,
});

export const SshRemoteViewSchema = z.object({
  remote: SshRemoteSchema,
  /** Boxes whose `sshRemoteRefs` name this remote. */
  referencedBy: z.array(z.string()),
  /** Whether the server runs a tunnel for it. */
  tunnelUp: z.boolean(),
  /** The tunnel's last error output, or `null`. */
  tunnelError: z.string().nullable(),
});

export const SshTestResultSchema = z.object({
  ok: z.boolean(),
  /** True when the remote refused the key; `copy-id` can fix that. */
  authFailed: z.boolean(),
  output: z.string(),
});

/** A directory's subdirectories, for a folder picker. Files are never listed. */
export const DirListingSchema = z.object({
  /** The absolute, normalized path that was listed. */
  path: z.string().min(1),
  /** The parent directory, or `null` at the file system root. */
  parent: z.string().min(1).nullable(),
  /** Subdirectories, sorted by name. */
  entries: z.array(z.object({ name: z.string().min(1), path: z.string().min(1) })),
  /**
   * Whether the directory holds an executable `new-issue.sh`, the marker of a
   * tree organised into per-issue folders. New Box then defaults to a
   * workspace folder, as `layout: "auto"` does.
   */
  newIssueScript: z.boolean().optional(),
});
export type DirListing = z.infer<typeof DirListingSchema>;

/** What the one-time import of the 3.3.5 records applied, or with `dryRun`, would apply. */
export const ImportReportSchema = z.object({
  dryRun: z.boolean(),
  projects: z.number().int().nonnegative(),
  boxes: z.number().int().nonnegative(),
  sshRemotes: z.number().int().nonnegative(),
  /** Whether the global settings were, or would be, imported. */
  settingsApplied: z.boolean(),
  /** Records and mounts the import skipped or changed, one sentence each. */
  warnings: z.array(z.string()),
});
export type ImportReport = z.infer<typeof ImportReportSchema>;

export const OpStatusSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  signedIn: z.boolean(),
  mode: z.enum(["service_account", "desktop", "none"]),
});
export type OpStatus = z.infer<typeof OpStatusSchema>;

export const SecretsViewSchema = z.object({
  global: z.array(SecretRefSchema),
  projects: z.array(z.object({ projectId: z.string(), refs: z.array(SecretRefSchema) })),
  op: OpStatusSchema,
});

/**
 * One 1Password field a project can reference. It holds the field's label,
 * section and type, and never its value.
 */
export const SecretCandidateSchema = z.object({
  vault: z.string(),
  item: z.string(),
  itemId: z.string(),
  /** The field's label. */
  field: z.string(),
  section: z.string().optional(),
  /** The field's type in 1Password, for example `CONCEALED` or `STRING`. */
  type: z.string(),
  ref: OpReferenceSchema,
  /** A proposed environment variable name, for example `TOKEN_GITHUB_CREDENTIAL`. */
  suggestedName: EnvVarNameSchema,
});
export type SecretCandidate = z.infer<typeof SecretCandidateSchema>;

export const SecretsAvailableSchema = z.object({
  /** The vaults that were searched. */
  vaults: z.array(z.string()),
  candidates: z.array(SecretCandidateSchema),
  /** Vaults that couldn't be read, with the reason; the others are in `candidates`. */
  vaultErrors: z.array(z.object({ vault: z.string(), message: z.string() })),
  /** When the server read the list from 1Password. */
  fetchedAt: IsoDateTimeSchema,
});
export type SecretsAvailable = z.infer<typeof SecretsAvailableSchema>;

/** The result of resolving references. Values never leave the server. */
export const SecretsCheckResultSchema = z.object({
  op: OpStatusSchema,
  results: z.array(
    z.object({
      name: z.string(),
      ref: z.string(),
      scope: z.enum(["global", "project"]),
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
});

export const RunListQuerySchema = z.object({
  projectId: z.string().optional(),
  boxId: z.string().optional(),
  status: RunStatusSchema.optional(),
});

export const RunPreviewSchema = z.object({
  /** The vendors with an adapter in the container. Absent from an older engine. */
  vendors: z.array(VendorSchema).optional(),
  baseSha: CommitShaSchema,
  tipSha: CommitShaSchema,
  /** The commit the diff starts from: the merge base, or `baseSha` with `exactBase`. */
  diffBaseSha: CommitShaSchema,
  groups: z.array(FileGroupSchema),
  changedLines: z.number().int().nonnegative(),
  dirty: z.boolean(),
  /** A rough estimate from code, with no model call. Absent from an older engine. */
  tokenEstimate: z
    .object({
      tokens: z.number().nonnegative(),
      /** The likely range. Absent from an older engine. */
      low: z.number().nonnegative().optional(),
      high: z.number().nonnegative().optional(),
      basis: z.string(),
      /** The stages behind the total. Absent from an older engine. */
      lines: z
        .array(
          z.object({
            label: z.string(),
            tokens: z.number().nonnegative(),
            low: z.number().nonnegative(),
            high: z.number().nonnegative(),
            source: z.string(),
          }),
        )
        .optional(),
    })
    .optional(),
  /** The files the run leaves out. Absent from an older engine. */
  excluded: z
    .object({
      /** Every excluded file, which can be more than `files` lists. */
      count: z.number().int().nonnegative(),
      /** The first excluded files by path, each with the list that excludes it. */
      files: z.array(z.object({ path: z.string(), source: z.enum(["built-in", "policy", "run"]) })),
    })
    .optional(),
});

export const FindingListQuerySchema = z.object({
  verdict: VerdictSchema.optional(),
  severity: SeveritySchema.optional(),
  round: queryInt.optional(),
});

export const FindingDetailSchema = z.object({
  finding: FindingSchema,
  /** The diff hunks the finding points at, or `null`. */
  diff: z.string().nullable(),
  /** The fix commit's diff once fixed, or `null`. */
  fixDiff: z.string().nullable(),
});

export const UsageSamplesQuerySchema = z.object({
  vendor: VendorSchema.optional(),
  since: IsoDateTimeSchema.optional(),
  until: IsoDateTimeSchema.optional(),
});

export const TimedUsageSampleSchema = UsageSampleSchema.extend({ time: IsoDateTimeSchema });
export type TimedUsageSample = z.infer<typeof TimedUsageSampleSchema>;

export const VendorUsageSchema = z.object({
  vendor: VendorSchema,
  account: z.string(),
  ceiling: CeilingSchema,
  /** The latest sample per window. */
  latest: z.array(TimedUsageSampleSchema),
  overCeiling: z.boolean(),
  /** When the ceiling will be reached at the current rate; `null` when it won't. */
  forecastAt: IsoDateTimeSchema.nullable(),
  resetAt: IsoDateTimeSchema.nullable(),
  window: UsageWindowSchema,
});

export const EventsQuerySchema = z.object({
  /** Comma-separated event types to receive; absent means all. */
  types: z.string().optional(),
});

export const HealthSchema = z.object({
  version: z.string().min(1),
  uptimeS: z.number().nonnegative(),
});

export const EngineHealthSchema = HealthSchema.extend({
  engineVersion: z.string().min(1),
  container: z.string().min(1),
  projectRoot: z.string().min(1),
  /** The engine's event `streamId`. */
  streamId: z.string().min(1),
  /**
   * Whether `engineVersion` equals `AIO_ENGINE_VERSION`. The engine
   * starts on a mismatch and reports `false` here.
   */
  versionMatches: z.boolean(),
});

export const RepoInfoSchema = z.object({
  /** Path as the container sees it. */
  path: z.string().min(1),
  name: z.string().min(1),
  currentBranch: z.string().nullable(),
  /** `null` for a repository with no commits. */
  headSha: CommitShaSchema.nullable(),
  dirty: z.boolean(),
});

export const RepoListSchema = z.object({ repos: z.array(RepoInfoSchema) });

export const RepoRefsQuerySchema = z.object({
  repo: z.string().min(1),
  /** `true` fetches from the repository's remotes first. */
  fetch: z.enum(["true", "false"]).optional(),
});

export const RepoRefsSchema = z.object({
  /** Why a requested fetch failed, so the lists can be out of date. */
  fetchError: z.string().optional(),
  localBranches: z.array(z.string()),
  remoteBranches: z.array(z.string()),
  tags: z.array(z.string()),
  recentCommits: z.array(
    z.object({
      sha: CommitShaSchema,
      subject: z.string(),
      author: z.string(),
      time: IsoDateTimeSchema,
    }),
  ),
  pullRequests: z.array(
    z.object({
      number: z.number().int().positive(),
      title: z.string(),
      headRef: z.string(),
      baseRef: z.string(),
      url: z.string().url(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Routes shared by the server (proxied) and the engine: runs, findings, usage samples

function reviewRoutes<const P extends string, B extends z.ZodTypeAny, V extends z.ZodTypeAny>(
  prefix: P,
  createBody: B,
  previewBody: V,
  usageSummary: string,
) {
  const runs = `${prefix}/runs`;
  const runErrors = ["run_not_found", "invalid_state"] as const;
  return {
    "runs.list": http({
      method: "GET",
      path: runs,
      summary: "List runs.",
      query: RunListQuerySchema,
      response: z.object({ runs: z.array(RunStateSchema) }),
    }),
    "runs.preview": http({
      method: "POST",
      path: `${runs}/preview`,
      summary: "Resolve the range and show the file groups without starting.",
      body: previewBody,
      response: RunPreviewSchema,
    }),
    "runs.create": http({
      method: "POST",
      path: runs,
      summary: "Start a run.",
      body: createBody,
      response: RunStateSchema,
      status: 201,
      errors: ["dirty_tree", "conflict"],
    }),
    "runs.get": http({
      method: "GET",
      path: `${runs}/:runId`,
      summary: "Get a run.",
      response: RunStateSchema,
      errors: ["run_not_found"],
    }),
    "runs.pause": http({
      method: "POST",
      path: `${runs}/:runId/pause`,
      summary: "Pause after the current agent call.",
      response: RunStateSchema,
      errors: runErrors,
    }),
    "runs.resume": http({
      method: "POST",
      path: `${runs}/:runId/resume`,
      summary: "Resume a paused run.",
      response: RunStateSchema,
      errors: runErrors,
    }),
    "runs.cancel": http({
      method: "POST",
      path: `${runs}/:runId/cancel`,
      summary: "Cancel a run.",
      response: RunStateSchema,
      errors: runErrors,
    }),
    "runs.profile": http({
      method: "PUT",
      path: `${runs}/:runId/profile`,
      summary: "Switch the profile from the next round.",
      body: z.object({ profile: ProfileSchema }),
      response: RunStateSchema,
      errors: runErrors,
    }),
    "runs.assign": http({
      method: "POST",
      path: `${runs}/:runId/assign`,
      summary: "Give a role to one or more vendors, for calls that haven't started.",
      body: z.object({ role: RoleSchema, vendors: z.array(VendorSchema).min(1) }),
      response: RunStateSchema,
      errors: runErrors,
    }),
    "runs.rebaseBase": http({
      method: "POST",
      path: `${runs}/:runId/rebase-base`,
      summary: "Re-resolve the base; the next round starts from it.",
      response: RunStateSchema,
      errors: runErrors,
    }),
    "runs.retry": http({
      method: "POST",
      path: `${runs}/:runId/retry`,
      summary: "Resume a failed run from its saved state at the stage that failed.",
      body: RunRetrySchema,
      response: RunStateSchema,
      errors: runErrors,
    }),
    "runs.decide": http({
      method: "POST",
      path: `${runs}/:runId/decision`,
      summary: "Answer the decision a run waits for.",
      body: DecisionAnswerSchema,
      response: RunStateSchema,
      errors: runErrors,
    }),
    "runs.push": http({
      method: "POST",
      path: `${runs}/:runId/push`,
      summary: "Push the branch, open or update the pull request, and start the post-push loop.",
      body: z.object({ title: z.string().optional(), draft: z.boolean().default(false) }),
      response: RunStateSchema,
      errors: runErrors,
    }),
    "runs.groups": http({
      method: "GET",
      path: `${runs}/:runId/groups`,
      summary: "List the run's file groups.",
      response: z.object({ groups: z.array(FileGroupSchema) }),
      errors: ["run_not_found"],
    }),
    "runs.rounds": http({
      method: "GET",
      path: `${runs}/:runId/rounds`,
      summary: "List the run's round summaries.",
      response: z.object({ rounds: z.array(RoundSummarySchema) }),
      errors: ["run_not_found"],
    }),
    "findings.list": http({
      method: "GET",
      path: `${runs}/:runId/findings`,
      summary: "List a run's findings.",
      query: FindingListQuerySchema,
      response: z.object({ findings: z.array(FindingSchema) }),
      errors: ["run_not_found"],
    }),
    "findings.get": http({
      method: "GET",
      path: `${runs}/:runId/findings/:findingId`,
      summary: "Get a finding with its diff and fix.",
      response: FindingDetailSchema,
      errors: ["run_not_found"],
    }),
    "findings.waive": http({
      method: "POST",
      path: `${runs}/:runId/findings/:findingId/waive`,
      summary: "Waive a finding.",
      body: z.object({ reason: z.string().min(1) }),
      response: FindingSchema,
      errors: runErrors,
    }),
    "usage.samples": http({
      method: "GET",
      path: `${prefix}/usage/samples`,
      summary: usageSummary,
      query: UsageSamplesQuerySchema,
      response: z.object({ samples: z.array(TimedUsageSampleSchema) }),
    }),
  };
}

type Prefixed<P extends string, T> = { [K in keyof T & string as `${P}${K}`]: T[K] };

function prefixKeys<const P extends string, T extends Record<string, unknown>>(
  p: P,
  table: T,
): Prefixed<P, T> {
  return Object.fromEntries(Object.entries(table).map(([k, v]) => [`${p}${k}`, v])) as Prefixed<
    P,
    T
  >;
}

// ---------------------------------------------------------------------------
// Multi-host: this machine's link to a hub

/** The state of a node's link to its hub; `none` when the machine hasn't joined one. */
export const NodeLinkStateSchema = z.enum([
  "none",
  "connecting",
  "connected",
  "disconnected",
  "refused",
  "revoked",
]);
export type NodeLinkState = z.infer<typeof NodeLinkStateSchema>;

/** This machine's multi-host state, from `GET /api/v1/node`. */
export const NodeStatusSchema = z.object({
  role: MachineRoleSchema,
  /** The name this machine shows and enrolls under. */
  name: z.string(),
  /** The id the hub gave this machine, or `null` before it joins one. */
  machineId: z.string().nullable(),
  /** The hub's link URL, or `null` before this machine joins one. */
  hubUrl: z.string().nullable(),
  link: NodeLinkStateSchema,
  /** Why the link is down, refused, or revoked; never holds a secret. */
  error: z.string().nullable(),
  /** The port the hub listens on for node links, or `null` while it doesn't. */
  linkPort: PortSchema.nullable(),
  /**
   * The role from `--role` or `AIO_ROLE`, when the server runs with one. It
   * sets `role`, and a stored role has no effect until the override goes.
   */
  roleOverride: MachineRoleSchema.optional(),
});
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

/** The body of `POST /api/v1/node/join`. */
export const NodeJoinSchema = z
  .object({
    /** The hub URL from the enrollment code, such as `https://hub.example.com:21402`. */
    hubUrl: z.string().url(),
    /** The one-time enrollment code the hub issued. */
    code: z.string().trim().min(1),
    /** The name to enroll under. Default: the `machineName` setting, else the host name. */
    name: EnrollMachineNameSchema.optional(),
    /**
     * Lets a machine whose stored role is `hub` and that has no enrolled
     * machines join. The role changes from `hub` to `node` only when the join
     * succeeds. Default: a `hub` machine can't join.
     */
    leaveHubRole: z.boolean().optional(),
    /**
     * Lets a machine that has joined a hub replace that enrollment. The old
     * hub keeps listing the machine until you revoke it there. Default: the
     * join fails with `conflict`, unless the old hub revoked this machine.
     */
    replaceHub: z.boolean().optional(),
  })
  .strict();
export type NodeJoin = z.infer<typeof NodeJoinSchema>;

// ---------------------------------------------------------------------------
// Server API

const projects = `${V1}/projects`;
const boxes = `${V1}/boxes`;
const sshRemotes = `${V1}/ssh-remotes`;
const accounts = `${V1}/accounts`;

export const serverRoutes = {
  health: http({
    method: "GET",
    path: `${V1}/health`,
    auth: false,
    summary: "Server version and uptime.",
    response: HealthSchema,
  }),
  "auth.session": http({
    method: "POST",
    path: `${V1}/auth/session`,
    summary: "Set the `aio_session` cookie; needs the bearer header.",
    response: OkSchema,
  }),

  // Projects
  "projects.list": http({
    method: "GET",
    path: projects,
    summary: "List projects with box counts.",
    response: z.object({ projects: z.array(ProjectSummarySchema) }),
  }),
  "projects.create": http({
    method: "POST",
    path: projects,
    summary: "Register a directory as a project.",
    body: ProjectCreateSchema,
    response: ProjectSchema,
    status: 201,
    errors: ["conflict"],
  }),
  "projects.get": http({
    method: "GET",
    path: `${projects}/:projectId`,
    summary: "Get a project.",
    response: ProjectSummarySchema,
  }),
  "projects.update": http({
    method: "PATCH",
    path: `${projects}/:projectId`,
    summary: "Change a project's name or settings.",
    body: ProjectUpdateSchema,
    response: ProjectUpdateResultSchema,
  }),
  "projects.remove": http({
    method: "DELETE",
    path: `${projects}/:projectId`,
    summary:
      "Delete a project's record. Refused when it has boxes, unless `force` removes their records too. Never deletes the folder, worktrees, or transcripts.",
    query: z.object({ force: QueryBooleanSchema.default("false") }),
    response: z.object({ removed: z.boolean(), boxes: z.array(z.string()) }),
    errors: ["conflict", "box_running"],
  }),
  "projects.restartContainer": http({
    method: "POST",
    path: `${projects}/:projectId/container/restart`,
    summary: "Restart the project's container and every box that was running in it.",
    response: BulkResultSchema,
    errors: ["secrets_locked", "secrets_unavailable", "engine_mismatch", "image_missing"],
  }),
  "projects.policy.get": http({
    method: "GET",
    path: `${projects}/:projectId/policy`,
    summary: "Read the policy file, or the default when there is none.",
    response: PolicyResultSchema,
  }),
  "projects.policy.put": http({
    method: "PUT",
    path: `${projects}/:projectId/policy`,
    summary: "Write the policy file.",
    query: z.object({ baseRevision: z.string().min(1).optional() }),
    body: PolicyPutSchema,
    response: PolicyResultSchema,
    errors: ["conflict"],
  }),
  "projects.repos.list": http({
    method: "GET",
    path: `${projects}/:projectId/repos`,
    summary: "List git repositories under the project root; proxied to the project's engine.",
    response: RepoListSchema,
  }),
  "projects.repos.refs": http({
    method: "GET",
    path: `${projects}/:projectId/repos/refs`,
    summary: "Branches, tags, recent commits, and open pull requests of a repository; proxied.",
    query: RepoRefsQuerySchema,
    response: RepoRefsSchema,
  }),

  // Boxes
  "boxes.list": http({
    method: "GET",
    path: boxes,
    summary: "List boxes.",
    query: z.object({ projectId: z.string().optional() }),
    response: z.object({ boxes: z.array(BoxViewSchema) }),
  }),
  "boxes.create": http({
    method: "POST",
    path: boxes,
    summary: "Create a box (new, adopted, or forked conversation) as a job.",
    body: BoxCreateSchema,
    response: JobSchema,
    status: 202,
    errors: [
      "adoption_refused",
      "session_tracked",
      "secrets_locked",
      "secrets_unavailable",
      "engine_mismatch",
      "image_missing",
      "stale_mounts",
    ],
  }),
  "boxes.get": http({
    method: "GET",
    path: `${boxes}/:boxId`,
    summary: "Get a box.",
    response: BoxViewSchema,
  }),
  "boxes.update": http({
    method: "PATCH",
    path: `${boxes}/:boxId`,
    summary: "Edit a box; relinks the conversation when `sessionUuid` changes.",
    body: BoxUpdateSchema,
    response: BoxUpdateResultSchema,
    errors: ["adoption_refused", "session_tracked"],
  }),
  "boxes.start": http({
    method: "POST",
    path: `${boxes}/:boxId/start`,
    summary: "Start a box's session; `force` starts it despite stale mounts.",
    body: BoxStartSchema,
    response: BoxViewSchema,
    errors: [
      "box_running",
      "stale_mounts",
      "secrets_locked",
      "secrets_unavailable",
      "engine_mismatch",
      "image_missing",
    ],
  }),
  "boxes.stop": http({
    method: "POST",
    path: `${boxes}/:boxId/stop`,
    summary: "Stop a box's session.",
    response: BoxViewSchema,
  }),
  "boxes.restart": http({
    method: "POST",
    path: `${boxes}/:boxId/restart`,
    summary: "Stop and start a box's session.",
    response: BoxViewSchema,
    errors: ["stale_mounts", "secrets_locked", "secrets_unavailable", "engine_mismatch"],
  }),
  "boxes.remove": http({
    method: "DELETE",
    path: `${boxes}/:boxId`,
    summary: "Remove a stopped box from the dashboard; the conversation stays.",
    query: z.object({ removeWorktree: QueryBooleanSchema.default("false") }),
    response: BoxRemoveResultSchema,
    errors: ["box_running"],
  }),
  "boxes.purge": http({
    method: "POST",
    path: `${boxes}/:boxId/purge`,
    summary:
      "Delete the transcripts and records for the box's directory, or list them with `dryRun`.",
    body: PurgeRequestSchema,
    response: PurgeResultSchema,
    errors: ["box_running"],
  }),
  "boxes.move": http({
    method: "POST",
    path: `${boxes}/:boxId/move`,
    summary: "Rename the working directory and repoint every record that uses it.",
    body: z.object({ newDir: z.string().min(1) }),
    response: z.object({ movedBoxes: z.array(z.string()) }),
    errors: ["box_running", "conflict"],
  }),
  "boxes.relink": http({
    method: "POST",
    path: `${boxes}/:boxId/relink`,
    summary: "Repoint this record at another directory (Change Working Directory).",
    body: z.object({ targetDir: z.string().min(1) }),
    response: BoxViewSchema,
    errors: ["box_running"],
  }),
  "boxes.convertToWorktree": http({
    method: "POST",
    path: `${boxes}/:boxId/convert-to-worktree`,
    summary: "Turn a workspace subfolder clone into a worktree, as a job.",
    body: z.object({ copyBuildOutput: z.boolean().default(false) }),
    response: JobSchema,
    status: 202,
    errors: ["box_running", "conflict"],
  }),
  "boxes.convertToWorktree.plan": http({
    method: "POST",
    path: `${boxes}/:boxId/convert-to-worktree/plan`,
    summary: "Preview Convert to Worktree without changing anything.",
    response: ConvertToWorktreePlanSchema,
    errors: ["box_running", "conflict"],
  }),
  "boxes.attachCommand": http({
    method: "GET",
    path: `${boxes}/:boxId/attach-command`,
    summary:
      "The argv that attaches an external terminal to a session, a side session, or a shell.",
    query: AttachCommandQuerySchema,
    response: z.object({ argv: z.array(z.string()).min(1) }),
  }),
  "boxes.sideSessions.start": http({
    method: "POST",
    path: `${boxes}/:boxId/side-sessions`,
    summary: "Start another CLI in its own tmux session next to the main one.",
    body: z.object({ platform: PlatformSchema }),
    response: z.object({ session: z.string().min(1) }),
    errors: ["conflict"],
  }),
  "boxes.sideSessions.stop": http({
    method: "DELETE",
    path: `${boxes}/:boxId/side-sessions/:platform`,
    summary: "Stop a side session.",
    response: OkSchema,
  }),
  "boxes.platform": http({
    method: "PUT",
    path: `${boxes}/:boxId/platform`,
    summary: "Change the main platform.",
    body: z.object({ platform: PlatformSchema, restart: z.boolean().default(false) }),
    response: BoxViewSchema,
  }),
  "boxes.message": http({
    method: "POST",
    path: `${boxes}/:boxId/message`,
    summary:
      "Send one message to the box's interactive session, such as the request to hold edits during a review.",
    body: z.object({ text: z.string().min(1) }),
    response: OkSchema,
  }),
  "boxes.startAll": http({
    method: "POST",
    path: `${boxes}/start-all`,
    summary: "Start stopped boxes whose `wasRunning` is set, or every stopped box.",
    body: z.object({ onlyWasRunning: z.boolean().default(true) }),
    response: BulkResultSchema,
  }),
  "boxes.stopAll": http({
    method: "POST",
    path: `${boxes}/stop-all`,
    summary: "Stop every running box.",
    response: BulkResultSchema,
  }),
  "boxes.restartAll": http({
    method: "POST",
    path: `${boxes}/restart-all`,
    summary: "Restart every running box.",
    response: BulkResultSchema,
  }),
  "stats.refresh": http({
    method: "POST",
    path: `${V1}/stats/refresh`,
    summary: "Sample container stats now; `container.stats` events follow.",
    response: OkSchema,
  }),

  // Terminals and jobs
  "terminals.open": ws({
    path: `${V1}/terminals`,
    summary: "Attach to a box's session, a side session, or a shell in a container.",
    query: TerminalQuerySchema,
    clientMessage: TerminalClientMessageSchema,
    serverMessage: TerminalServerMessageSchema,
  }),
  "jobs.get": http({
    method: "GET",
    path: `${V1}/jobs/:jobId`,
    summary: "Get a job's state.",
    response: JobSchema,
  }),
  "jobs.stream": ws({
    path: `${V1}/jobs/:jobId/stream`,
    summary: "Stream a job's terminal output.",
    query: z.object({}),
    clientMessage: TerminalClientMessageSchema,
    serverMessage: TerminalServerMessageSchema,
  }),

  // Catalog, models, image, updates, setup, settings, prompts
  "conversations.list": http({
    method: "GET",
    path: `${V1}/conversations`,
    summary: "List the transcripts Claude has for a working directory.",
    query: z.object({ dir: z.string().min(1) }),
    response: z.object({ dir: z.string(), conversations: z.array(ConversationSummarySchema) }),
  }),
  "models.list": http({
    method: "GET",
    path: `${V1}/models`,
    summary: "List models and the defaults for a directory.",
    query: z.object({
      dir: z.string().optional(),
      /** A Claude account id; absent means the default account. */
      account: AccountIdSchema.optional(),
    }),
    response: ModelsResultSchema,
  }),
  "models.rescan": http({
    method: "POST",
    path: `${V1}/models/rescan`,
    summary: "Rescan the image for model ids.",
    response: ModelsResultSchema,
    errors: ["image_missing"],
  }),
  "image.status": http({
    method: "GET",
    path: `${V1}/image`,
    summary: "Image, engine, and CLI versions.",
    response: ImageStatusSchema,
  }),
  "image.build": http({
    method: "POST",
    path: `${V1}/image/build`,
    summary: "Build or update the image.",
    body: ImageBuildSchema,
    response: JobSchema,
    status: 202,
  }),
  "updates.check": http({
    method: "GET",
    path: `${V1}/updates`,
    summary: "Check for an app release and for a Claude Code newer than the image's.",
    query: z.object({ force: QueryBooleanSchema.default("false") }),
    response: UpdatesSchema,
  }),
  "setup.get": http({
    method: "GET",
    path: `${V1}/setup`,
    summary: "Run the setup checks.",
    response: SetupStatusSchema,
  }),
  "setup.fix": http({
    method: "POST",
    path: `${V1}/setup/checks/:checkId/fix`,
    summary: "Fix a failed check.",
    response: JobSchema,
    status: 202,
  }),
  "setup.complete": http({
    method: "PUT",
    path: `${V1}/setup`,
    summary: "Finish the setup wizard.",
    body: z.object({ defaultTargetDir: z.string().min(1).optional() }),
    response: OkSchema,
  }),
  "settings.get": http({
    method: "GET",
    path: `${V1}/settings`,
    summary: "Read the global settings.",
    response: GlobalSettingsSchema,
  }),
  "settings.patch": http({
    method: "PATCH",
    path: `${V1}/settings`,
    summary: "Change editable global settings; server-owned fields are rejected.",
    body: GlobalSettingsPatchSchema,
    response: GlobalSettingsSchema,
  }),
  "prompts.get": http({
    method: "GET",
    path: `${V1}/prompts`,
    summary: "Read the prompt templates and their defaults.",
    response: PromptsResultSchema,
  }),
  "prompts.put": http({
    method: "PUT",
    path: `${V1}/prompts`,
    summary: "Replace the prompt templates.",
    body: PromptTemplatesSchema,
    response: PromptsResultSchema,
  }),
  "import.run": http({
    method: "POST",
    path: `${V1}/import`,
    summary: "Import the 3.3.5 records and settings, or report what it would import with `dryRun`.",
    body: z.object({ dryRun: z.boolean() }),
    response: ImportReportSchema,
  }),
  "fs.dirs": http({
    method: "GET",
    path: `${V1}/fs/dirs`,
    summary: "List a host directory's subdirectories; no `path` lists the home directory.",
    query: z.object({ path: z.string().min(1).optional() }),
    response: DirListingSchema,
  }),

  // SSH remotes, global mounts, secrets
  "sshRemotes.list": http({
    method: "GET",
    path: sshRemotes,
    summary: "List SSH remotes.",
    response: z.object({ remotes: z.array(SshRemoteViewSchema) }),
  }),
  "sshRemotes.put": http({
    method: "PUT",
    path: `${sshRemotes}/:name`,
    summary:
      "Create or replace a remote; a different `name` in the body renames it and rewrites box references.",
    body: SshRemoteInputSchema,
    response: SshRemoteViewSchema,
    errors: ["conflict"],
  }),
  "sshRemotes.delete": http({
    method: "DELETE",
    path: `${sshRemotes}/:name`,
    summary: "Delete a remote and drop it from every box.",
    response: z.object({ unlinkedBoxes: z.array(z.string()) }),
  }),
  "sshRemotes.test": http({
    method: "POST",
    path: `${sshRemotes}/test`,
    summary: "Test the connection to an unsaved remote.",
    body: SshRemoteInputSchema,
    response: SshTestResultSchema,
  }),
  "sshRemotes.testSaved": http({
    method: "POST",
    path: `${sshRemotes}/:name/test`,
    summary: "Test the connection: the saved remote, or the unsaved one in the body.",
    body: SshRemoteInputSchema.optional(),
    response: SshTestResultSchema,
  }),
  "sshRemotes.reconnect": http({
    method: "POST",
    path: `${sshRemotes}/:name/reconnect`,
    summary: "Restart the remote's tunnel.",
    response: SshRemoteViewSchema,
  }),
  "sshRemotes.copyId": http({
    method: "POST",
    path: `${sshRemotes}/:name/copy-id`,
    summary: "Run ssh-copy-id in a job terminal.",
    response: JobSchema,
    status: 202,
  }),
  // Accounts (phase 1)
  "accounts.list": http({
    method: "GET",
    path: accounts,
    summary: "List the accounts of every vendor.",
    response: z.object({ accounts: z.array(AccountViewSchema) }),
  }),
  "accounts.create": http({
    method: "POST",
    path: accounts,
    summary:
      "Create an account and its empty folder; the first account of a vendor becomes its default.",
    body: AccountCreateSchema,
    response: AccountViewSchema,
    status: 201,
    errors: ["conflict"],
  }),
  "accounts.seed": http({
    method: "POST",
    path: `${accounts}/seed`,
    summary:
      "Copy the host's agent folders into new accounts, leaving out the sign-in files, in an `account_seed` job.",
    body: AccountSeedRequestSchema,
    response: JobSchema,
    status: 202,
    errors: ["box_running", "conflict"],
  }),
  "accounts.import": http({
    method: "POST",
    path: `${accounts}/import`,
    summary:
      "Install a ready, signed-in config folder as an account: move it, or with `copy` copy it. Never reads the sign-in files.",
    body: AccountImportRequestSchema,
    response: AccountImportResultSchema,
    status: 201,
    errors: ["conflict", "validation"],
  }),
  "accounts.relink": http({
    method: "POST",
    path: `${accounts}/relink`,
    summary:
      "Point every Claude account's `projects` entry at the shared transcript store, replacing a link that dangles or leads elsewhere.",
    response: AccountRelinkResultSchema,
  }),
  "transcripts.adopt": http({
    method: "POST",
    path: `${V1}/transcripts/adopt`,
    summary:
      "Move the host's `~/.claude/projects` transcripts into the store and point `~/.claude/projects` at it. Refuses while a box runs. `dryRun` changes nothing.",
    body: TranscriptsAdoptRequestSchema,
    response: TranscriptsAdoptResultSchema,
    errors: ["box_running"],
  }),
  "accounts.get": http({
    method: "GET",
    path: `${accounts}/:vendor/:name`,
    summary: "Get an account.",
    response: AccountViewSchema,
  }),
  "accounts.update": http({
    method: "PATCH",
    path: `${accounts}/:vendor/:name`,
    summary: "Change an account's label, ceiling, or overflow.",
    body: AccountUpdateSchema,
    response: AccountViewSchema,
  }),
  "accounts.remove": http({
    method: "DELETE",
    path: `${accounts}/:vendor/:name`,
    summary: "Delete an account record, never its folder; refused for a vendor's default.",
    response: AccountRemoveResultSchema,
    errors: ["conflict"],
  }),
  "accounts.check": http({
    method: "POST",
    path: `${accounts}/:vendor/:name/check`,
    summary: "Ask the vendor CLI, in a throwaway container, whether the account is signed in.",
    response: AccountViewSchema,
    errors: ["image_missing"],
  }),
  "globalMounts.get": http({
    method: "GET",
    path: `${V1}/global-mounts`,
    summary: "Read the global mounts.",
    response: z.object({ mounts: z.array(MountSchema) }),
  }),
  "globalMounts.put": http({
    method: "PUT",
    path: `${V1}/global-mounts`,
    summary: "Replace the global mounts; host directories must exist.",
    body: z.object({ mounts: z.array(MountSchema) }),
    response: z.object({ mounts: z.array(MountSchema), staleContainers: z.array(z.string()) }),
  }),
  "secrets.get": http({
    method: "GET",
    path: `${V1}/secrets`,
    summary: "List secret references and the 1Password CLI state. Never values.",
    response: SecretsViewSchema,
  }),
  "secrets.put": http({
    method: "PUT",
    path: `${V1}/secrets`,
    summary: "Replace the global secret references.",
    body: z.object({ refs: z.array(SecretRefSchema) }),
    response: z.object({ refs: z.array(SecretRefSchema) }),
  }),
  "secrets.available": http({
    method: "GET",
    path: `${V1}/secrets/available`,
    summary:
      "List the 1Password fields a project can reference, with a proposed variable name. Never values. Cached for 30 seconds; refresh=true bypasses the cache.",
    query: z.object({ refresh: QueryBooleanSchema.default("false") }),
    response: SecretsAvailableSchema,
    errors: ["secrets_locked", "secrets_unavailable"],
  }),
  "secrets.check": http({
    method: "POST",
    path: `${V1}/secrets/check`,
    summary: "Try to resolve references, globally or for one project.",
    body: z.object({ projectId: z.string().optional() }),
    response: SecretsCheckResultSchema,
  }),

  // Review (proxied to the engine, except usage.samples) and usage
  ...reviewRoutes(
    V1,
    RunRequestSchema,
    RunRequestSchema,
    "List usage samples from the server's SQLite mirror, across every engine.",
  ),
  "usage.get": http({
    method: "GET",
    path: `${V1}/usage`,
    summary: "Usage per vendor account against its ceiling.",
    response: z.object({
      vendors: z.array(VendorUsageSchema),
      /** The server's clock, which reset times compare against. */
      time: z.string().optional(),
    }),
  }),
  "usage.clear": http({
    method: "POST",
    path: `${V1}/usage/clear`,
    summary:
      "Clear a vendor's usage block, such as after you buy a reset. The next real sample replaces it.",
    body: z.object({ vendor: VendorSchema, account: z.string().min(1).optional() }),
    response: z.object({ vendors: z.array(VendorUsageSchema), cleared: z.number().int() }),
  }),

  // Machines (multi-host)
  "machines.list": http({
    method: "GET",
    path: `${V1}/machines`,
    summary:
      "List the machines: this one first, as id local. On a node, the rest comes from the hub, and shows offline while the hub is unreachable.",
    response: MachineListSchema,
  }),
  "machines.enroll": http({
    method: "POST",
    path: `${V1}/machines/enrollment-codes`,
    summary: "Issue a one-time enrollment code for a node to join this hub. Hub only.",
    response: EnrollmentCodeSchema,
    status: 201,
    errors: ["invalid_state"],
  }),
  "machines.revoke": http({
    method: "DELETE",
    path: `${V1}/machines/:id`,
    summary: "Revoke a machine's certificate and close its link. Hub only.",
    response: OkSchema,
    errors: ["invalid_state"],
  }),
  "gui.list": http({
    method: "GET",
    path: `${V1}/gui-clients`,
    summary: "List the GUI apps enrolled with this hub, and the GUI listener's port. Hub only.",
    response: GuiClientListSchema,
    errors: ["invalid_state"],
  }),
  "gui.enroll": http({
    method: "POST",
    path: `${V1}/gui-clients/enrollment-codes`,
    summary: "Issue a one-time code for a GUI app on another PC to enroll with this hub. Hub only.",
    response: EnrollmentCodeSchema,
    status: 201,
    errors: ["invalid_state"],
  }),
  "gui.revoke": http({
    method: "DELETE",
    path: `${V1}/gui-clients/:id`,
    summary: "Revoke a GUI app's certificate and close its connections. Hub only.",
    response: OkSchema,
    errors: ["invalid_state"],
  }),
  "node.get": http({
    method: "GET",
    path: `${V1}/node`,
    summary: "This machine's role and its link to a hub.",
    response: NodeStatusSchema,
  }),
  "node.health": http({
    method: "GET",
    path: `${V1}/node/health`,
    summary:
      "This machine's health for the Machines page: the image's engine version and the free disk space.",
    response: MachineHealthSchema,
  }),
  "node.join": http({
    method: "POST",
    path: `${V1}/node/join`,
    summary:
      "Join a hub with a one-time enrollment code: get a client certificate, pin the hub's certificate, and connect.",
    body: NodeJoinSchema,
    response: NodeStatusSchema,
    errors: ["hub_unreachable", "invalid_state", "conflict", "unauthorized"],
  }),

  // Notifications and events
  "notifications.list": http({
    method: "GET",
    path: `${V1}/notifications`,
    summary: "List notifications.",
    query: z.object({ unread: QueryBooleanSchema.optional() }),
    response: z.object({ notifications: z.array(NotificationSchema) }),
  }),
  "notifications.read": http({
    method: "POST",
    path: `${V1}/notifications/:notificationId/read`,
    summary: "Mark a notification read.",
    response: OkSchema,
  }),
  "events.stream": ws({
    path: `${V1}/events`,
    summary: "Every server event and every engine event, relayed and re-numbered.",
    query: EventsQuerySchema,
    clientMessage: ClientHelloSchema,
    serverMessage: ServerStreamFrameSchema,
  }),
} as const;

// ---------------------------------------------------------------------------
// Engine API

export const engineRoutes = {
  "engine.health": http({
    method: "GET",
    path: `${V1}/health`,
    auth: false,
    summary: "Engine version and identity.",
    response: EngineHealthSchema,
  }),
  "engine.repos.list": http({
    method: "GET",
    path: `${V1}/repos`,
    summary: "List git repositories under the project root.",
    response: RepoListSchema,
  }),
  "engine.repos.refs": http({
    method: "GET",
    path: `${V1}/repos/refs`,
    summary: "Branches, tags, recent commits, and open pull requests of a repository.",
    query: RepoRefsQuerySchema,
    response: RepoRefsSchema,
  }),
  ...prefixKeys(
    "engine.",
    reviewRoutes(
      V1,
      EngineRunCreateSchema,
      EngineRunPreviewSchema,
      "List the engine's usage samples from its run files.",
    ),
  ),
  "engine.ports": http({
    method: "GET",
    path: `${V1}/ports`,
    summary: "Listening TCP ports in the container.",
    response: z.object({ listeners: z.array(ListenerSchema) }),
  }),
  "engine.events": ws({
    path: `${V1}/events`,
    summary:
      "The engine's events and lease requests; the server answers leases on the same socket.",
    query: EventsQuerySchema,
    clientMessage: EngineStreamClientFrameSchema,
    serverMessage: EngineStreamFrameSchema,
  }),
  "engine.proxy": {
    kind: "proxy",
    method: "ALL",
    path: "/proxy/:port/*",
    auth: true,
    summary: "Forward HTTP and WebSocket traffic to `127.0.0.1:<port>` in the container.",
  },
} as const;

/** Every route, keyed by name. Engine keys start with `engine.`. */
export const routes = { ...serverRoutes, ...engineRoutes } as const;

export type ServerRoutes = typeof serverRoutes;
export type EngineRoutes = typeof engineRoutes;
export type Routes = typeof routes;
export type RouteKey = keyof Routes;
export type ServerRouteKey = keyof ServerRoutes;
export type EngineRouteKey = keyof EngineRoutes;

// Type-level check that every entry is a valid `RouteDef`.
type AssertRoutes<T extends Record<string, RouteDef>> = T;
export type _CheckRoutes = AssertRoutes<Routes>;

// ---------------------------------------------------------------------------
// Typed helpers

/** The names of the `:params` in a path, as a union of string literals. */
export type PathParamName<P extends string> = P extends `${string}:${infer Name}/${infer Rest}`
  ? Name | PathParamName<`/${Rest}`>
  : P extends `${string}:${infer Name}`
    ? Name
    : never;

/** The params object for a path. */
export type PathParams<P extends string> = { [K in PathParamName<P>]: string };

type Inferred<T> = T extends z.ZodTypeAny ? z.infer<T> : undefined;
type Input<T> = T extends z.ZodTypeAny ? z.input<T> : undefined;

/**
 * The typed shape of route `K`: what a client sends and receives. `query` and
 * `body` are the inputs a client sends (before defaults); `response`,
 * `serverMessage`, and `clientMessage` are parsed outputs.
 */
export type RouteOf<K extends RouteKey> = Routes[K] extends infer R
  ? R extends { path: infer P extends string }
    ? {
        key: K;
        kind: R extends { kind: infer Kind } ? Kind : never;
        method: R extends { method: infer M } ? M : never;
        path: P;
        params: PathParams<P>;
        query: R extends { query: infer Q } ? Input<Q> : undefined;
        body: R extends { body: infer B } ? Input<B> : undefined;
        response: R extends { response: infer S } ? Inferred<S> : undefined;
        clientMessage: R extends { clientMessage: infer C } ? Inferred<C> : undefined;
        serverMessage: R extends { serverMessage: infer S } ? Inferred<S> : undefined;
      }
    : never
  : never;

/** Lists the `:param` names in a path, in order. */
export function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
}

/** Returns a zod schema for a path's params, for frameworks that validate them. */
export function pathParamsSchema(path: string): z.ZodObject<Record<string, z.ZodString>> {
  return z.object(Object.fromEntries(pathParamNames(path).map((n) => [n, z.string().min(1)])));
}

/**
 * Fills the `:params` in `path` with URL-encoded values. Throws on a missing
 * param, and on an empty, `.`, or `..` value: URL parsing would resolve
 * those segments and send the call to another route.
 */
export function buildPath<P extends string>(path: P, params: PathParams<P>): string {
  const values = params as Record<string, string | undefined>;
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`Missing path parameter "${name}" for ${path}.`);
    if (value === "" || value === "." || value === "..") {
      throw new Error(`Invalid path parameter "${name}": ${JSON.stringify(value)} isn't an ID.`);
    }
    return encodeURIComponent(value);
  });
}
