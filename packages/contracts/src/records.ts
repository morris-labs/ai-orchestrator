// Persistent records: projects, boxes, SSH remotes, and settings.
//
// The server stores these in SQLite (`~/.claude-box/agentbox.db`). The
// one-time import reads the 3.3.5 key-value files, so every field below maps
// to a key from `docs/v4/inventory-gui.md` section 3.
//
// Box: `~/.claude-box/known/<container-name>` (inventory 3.1)
//
// | 3.3.5 key                | TypeScript field        | Notes                                      |
// |--------------------------|-------------------------|--------------------------------------------|
// | (file name)              | `id`                    | `claude-agent-<base>`                      |
// | `target_dir`             | `targetDir`             |                                            |
// | `session_uuid`           | `sessionUuid`           | `null` when empty                          |
// | `conversation_name`      | `conversationName`      |                                            |
// | `transcript_synced_name` | `transcriptSyncedName`  |                                            |
// | `launched_model`         | `launchedModel`         |                                            |
// | `launched_effort`        | `launchedEffort`        |                                            |
// | `platform`               | `platform`              | absent means `claude`                      |
// | `model`                  | `model`                 | absent means the settings files decide     |
// | `effort`                 | `effort`                | absent means the settings files decide     |
// | `workspace`              | `workspace`             |                                            |
// | `worktree`               | `worktree`              |                                            |
// | `branch`                 | `branch`                |                                            |
// | `moved_from`             | `movedFrom`             |                                            |
// | `container`              | `container`             | absent for a classic box before its move   |
// | `session`                | `session`               |                                            |
// | `ssh_remote_ref` (rep.)  | `sshRemoteRefs`         | SSH remote names                           |
// | `yolo`                   | `skipPermissions`       | `1` means true; default true               |
// | `was_running`            | `wasRunning`            |                                            |
// | `port` (rep.)            | (dropped)               | 4.0.0 has no port pool                     |
// | `dir` (rep.)             | `Project.mounts`        | merged into the project, as `adopt()` did  |
// | `ssh_remote`, `ssh_identity`, `ssh_forward`, `ssh_host` | `SshRemote` | legacy inline remote, imported as a named remote |
// | `rc`                     | (ignored)               |                                            |
// | (new)                    | `projectId`, `createdAt`, `updatedAt`, `reviewState` |               |
//
// Project: `~/.claude-box/projects/<id>` (inventory 3.2)
//
// | 3.3.5 key            | TypeScript field | Notes                                         |
// |----------------------|------------------|-----------------------------------------------|
// | (file name)          | `id`             | `slug(basename)-<sha1(root)[0:8]>`            |
// | `root`               | `root`           | normalized, no trailing slash                 |
// | `name`               | `name`           | empty means the folder name                   |
// | `primary_repo`       | `primaryRepo`    | defaults to `root` when `root/.git` exists    |
// | `dir` (rep.)         | `mounts`         | `HOST[:CONTAINER]`; container defaults to host |
// | `port` (rep.)        | (dropped)        | the port pool is replaced by `tcpMaps`        |
// | `shared_container`   | (dropped)        | every project runs one shared container       |
// | (new)                | `tcpMaps`, `secretRefs`, `ceilingsOverride`, `policyPath` |      |
//
// SSH remote: `~/.claude-box/ssh_remotes/<sanitized>` (inventory 3.3)
//
// | 3.3.5 key         | TypeScript field |
// |-------------------|------------------|
// | `name`            | `name`           |
// | `host`            | `host`           |
// | `identity`        | `identity`       |
// | `forward` (rep.)  | `forwards`       |
//
// Global settings: `~/.claude-box/global` and QSettings (inventory 3.3, 3.4)
//
// | 3.3.5 source                 | TypeScript field              |
// |------------------------------|-------------------------------|
// | `global` file, `dir=` lines  | `globalMounts`                |
// | `prompts/workspace`          | `promptTemplates.workspace`   |
// | `prompts/worktree`           | `promptTemplates.worktree`    |
// | `prompts/portHint`           | `promptTemplates.portHint`    |
// | `prompts/starter`            | `promptTemplates.starter`     |
// | `setup/completed`            | `setupCompleted`              |
// | `setup/defaultTargetDir`     | `defaultTargetDir`            |
// | `setup/sshIdentity`          | `sshIdentity`                 |
// | `models/scan`, `models/imageId`, `models/scanTime` | `modelCache` |
// | `newBox/workspaceDirs`, `newBox/worktreeDirs`      | `newBoxDefaults` |
// | `ui/*`, `updateChecker/*`, `portAllocator/*`       | (not imported; app state) |
import { z } from "zod";
import {
  EffortSchema,
  EnvVarNameSchema,
  FractionSchema,
  IsoDateTimeSchema,
  PlatformSchema,
  PortSchema,
} from "./common.js";
import { DEFAULT_PROMPT_TEMPLATES } from "./prompts.js";

/** Every box container and shared container name starts with this prefix. */
export const CONTAINER_PREFIX = "claude-agent-";

/** Returns the shared container name for a project: `claude-agent-proj-<id>`. */
export function projectContainerName(projectId: string): string {
  return `${CONTAINER_PREFIX}proj-${projectId}`;
}

// ---------------------------------------------------------------------------
// Building blocks

/**
 * A bind mount. The import fills `container` from the host path (through the
 * host-to-container path mapping) when a 3.3.5 `dir=` line has no
 * `:CONTAINER` part.
 */
export const MountSchema = z.object({
  host: z.string().min(1),
  container: z.string().min(1),
});
export type Mount = z.infer<typeof MountSchema>;

/** An explicit `HOST:CONTAINER` TCP port map for a project's container. */
export const TcpMapSchema = z.object({
  host: PortSchema,
  container: PortSchema,
});
export type TcpMap = z.infer<typeof TcpMapSchema>;

/** A 1Password reference in the form `op://VAULT/ITEM/FIELD`. */
export const OpReferenceSchema = z.string().regex(/^op:\/\/[^/]+\/[^/]+\/.+$/, {
  message: "must have the form op://VAULT/ITEM/FIELD",
});

/**
 * A secret reference. The server resolves `ref` with `op read` at launch and
 * injects the value as the environment variable `name`. Values never appear
 * in a record, an API response, an event, or a log.
 */
export const SecretRefSchema = z.object({
  name: EnvVarNameSchema,
  ref: OpReferenceSchema,
});
export type SecretRef = z.infer<typeof SecretRefSchema>;

/**
 * A usage ceiling for one vendor. `utilization` ceilings compare against the
 * vendor's reported share of a rate-limit window, from 0 to 1. `spend`
 * ceilings compare against money spent in the billing period.
 */
export const CeilingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("utilization"),
    window: z.enum(["5h", "7d"]),
    max: FractionSchema,
  }),
  z.object({
    kind: z.literal("spend"),
    period: z.literal("month"),
    maxUsd: z.number().nonnegative(),
  }),
]);
export type Ceiling = z.infer<typeof CeilingSchema>;

export const DEFAULT_CEILINGS = {
  claude: { kind: "utilization", window: "5h", max: 0.6 },
  codex: { kind: "utilization", window: "5h", max: 0.7 },
  copilot: { kind: "spend", period: "month", maxUsd: 70 },
} as const satisfies Record<"claude" | "codex" | "copilot", Ceiling>;

/** Ceilings per vendor. Each key falls back to its default on its own. */
export const CeilingsSchema = z.object({
  claude: CeilingSchema.default(DEFAULT_CEILINGS.claude),
  codex: CeilingSchema.default(DEFAULT_CEILINGS.codex),
  copilot: CeilingSchema.default(DEFAULT_CEILINGS.copilot),
});
export type Ceilings = z.infer<typeof CeilingsSchema>;

/** A project's ceilings override: only the vendors it lists change. */
export const CeilingsOverrideSchema = z.object({
  claude: CeilingSchema.optional(),
  codex: CeilingSchema.optional(),
  copilot: CeilingSchema.optional(),
});
export type CeilingsOverride = z.infer<typeof CeilingsOverrideSchema>;

// ---------------------------------------------------------------------------
// Project

/** The project path, relative to the project root, of the default policy file. */
export const DEFAULT_POLICY_PATH = ".claude-box/policy.yaml";

/** Settings a person edits on a project. */
export const ProjectSettingsSchema = z.object({
  /** Explicit TCP maps. Dev servers need none: the engine proxies them. */
  tcpMaps: z.array(TcpMapSchema).default([]),
  /** Bind mounts on top of the project root and the global mounts. */
  mounts: z.array(MountSchema).default([]),
  /** Secrets injected into the project's container at launch. */
  secretRefs: z.array(SecretRefSchema).default([]),
  /** Per-vendor ceilings that replace the global ones for runs in this project. */
  ceilingsOverride: CeilingsOverrideSchema.optional(),
  /** Policy file path, relative to `root` unless absolute. */
  policyPath: z.string().min(1).default(DEFAULT_POLICY_PATH),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

/**
 * A project: a directory whose boxes share one container,
 * `projectContainerName(id)`. A project exists as soon as a box's
 * `targetDir` points at its root.
 */
export const ProjectSchema = ProjectSettingsSchema.extend({
  /** `slug(basename(root))-<first 8 hex digits of sha1(root)>`; ASCII letters and digits, case kept. */
  id: z.string().regex(/^[A-Za-z0-9-]+-[0-9a-f]{8}$/),
  root: z.string().min(1),
  name: z.string().min(1),
  primaryRepo: z.string().min(1).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

// ---------------------------------------------------------------------------
// SSH remotes

/**
 * One SSH port forward. The 3.3.5 file stores it as
 * `L|R:bindAddr:bindPort:destHost:destPort`.
 */
export const SshForwardSchema = z.object({
  direction: z.enum(["L", "R"]),
  bindAddress: z.string().default("localhost"),
  bindPort: PortSchema,
  destHost: z.string().min(1),
  destPort: PortSchema,
});
export type SshForward = z.infer<typeof SshForwardSchema>;

/** A named SSH remote. Boxes refer to it by `name` in `sshRemoteRefs`. */
export const SshRemoteSchema = z.object({
  name: z.string().min(1),
  /** `user@host[:port]`. */
  host: z.string().min(1),
  /** Path to the identity file on the host. */
  identity: z.string().min(1).optional(),
  forwards: z.array(SshForwardSchema).default([]),
});
export type SshRemote = z.infer<typeof SshRemoteSchema>;

// ---------------------------------------------------------------------------
// Box

/** Whether a review run holds the box's working tree. */
export const ReviewStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }),
  z.object({ state: z.literal("under_review"), runId: z.string().min(1) }),
]);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/**
 * A box: one conversation, run as a tmux session in its project's container.
 *
 * Derived values, which are not stored:
 *
 * - Working directory: `worktree` when set, else `targetDir`. See `boxWorkDir()`.
 *   Transcript lookups and the container's `-w` use it, never `targetDir`.
 * - Program: `platform`.
 * - Container: `container`, else `id` (a classic box before its move).
 * - tmux session: `session`, else `main` with `.` and `:` replaced by `_`.
 * - Side session for platform `p`: `<tmux session>-<p>`.
 */
export const BoxSchema = z.object({
  /** The box name, `claude-agent-<base>`; the 3.3.5 record's file name. */
  id: z.string().startsWith(CONTAINER_PREFIX),
  projectId: z.string().min(1),
  targetDir: z.string().min(1),
  /** Claude's session id. `null` starts a new conversation on the next start. */
  sessionUuid: z.string().uuid().nullable().default(null),
  conversationName: z.string().default(""),
  /** The transcript title last copied into `conversationName`. */
  transcriptSyncedName: z.string().default(""),
  platform: PlatformSchema.default("claude"),
  /** `--model`; absent means the settings files decide. */
  model: z.string().min(1).optional(),
  /** `--effort`; absent means the settings files decide. */
  effort: EffortSchema.optional(),
  /** Passes `--allow-dangerously-skip-permissions`. 3.3.5 key `yolo`. */
  skipPermissions: z.boolean().default(true),
  /** Workspace subfolder the opening prompt names. */
  workspace: z.string().min(1).optional(),
  /** Git worktree path. When set, the box runs there. */
  worktree: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  /** Old workspace folder after Convert to Worktree, until the next start. */
  movedFrom: z.string().min(1).optional(),
  /** Shared container name. Absent only for an imported classic box. */
  container: z.string().startsWith(CONTAINER_PREFIX).optional(),
  /** tmux session name inside `container`. */
  session: z.string().min(1).optional(),
  launchedModel: z.string().min(1).optional(),
  launchedEffort: EffortSchema.optional(),
  wasRunning: z.boolean().default(false),
  sshRemoteRefs: z.array(z.string().min(1)).default([]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  reviewState: ReviewStateSchema.default({ state: "idle" }),
});
export type Box = z.infer<typeof BoxSchema>;

/** Returns the directory a box's agent works in: the worktree, else the target directory. */
export function boxWorkDir(box: Pick<Box, "worktree" | "targetDir">): string {
  return box.worktree ?? box.targetDir;
}

// ---------------------------------------------------------------------------
// Global settings

/** Which events raise a desktop notification. */
export const NotificationTogglesSchema = z.object({
  decisionNeeded: z.boolean().default(true),
  runFinished: z.boolean().default(true),
  boxEnded: z.boolean().default(true),
  roundSummary: z.boolean().default(true),
});
export type NotificationToggles = z.infer<typeof NotificationTogglesSchema>;

/**
 * Prompt templates. An empty string turns a template off; 3.3.5 could not
 * turn the Starter off (inventory section 0, item 3).
 */
export const PromptTemplatesSchema = z.object({
  workspace: z.string().default(DEFAULT_PROMPT_TEMPLATES.workspace),
  worktree: z.string().default(DEFAULT_PROMPT_TEMPLATES.worktree),
  portHint: z.string().default(DEFAULT_PROMPT_TEMPLATES.portHint),
  starter: z.string().default(DEFAULT_PROMPT_TEMPLATES.starter),
});
export type PromptTemplates = z.infer<typeof PromptTemplatesSchema>;

/** The model list scanned from the engine image, cached against the image id. */
export const ModelCacheSchema = z.object({
  imageId: z.string().min(1),
  scannedAt: IsoDateTimeSchema,
  models: z.array(z.string().min(1)),
});
export type ModelCache = z.infer<typeof ModelCacheSchema>;

/** Per-directory defaults for the New Box form. */
export const NewBoxDefaultsSchema = z.object({
  /** Directory to whether a new box gets a workspace subfolder. */
  workspaceDirs: z.record(z.string(), z.boolean()).default({}),
  /** Directory to whether a new box gets a worktree. */
  worktreeDirs: z.record(z.string(), z.boolean()).default({}),
});
export type NewBoxDefaults = z.infer<typeof NewBoxDefaultsSchema>;

export const DEFAULT_SERVER_PORT = 20400;
export const DEFAULT_ENGINE_PORT = 20411;
export const DEFAULT_ENGINE_IMAGE = "claude-code";

/**
 * Global settings, stored at `~/.claude-box/config.json`. Every field has a
 * default, so `{}` parses to a complete configuration.
 */
export const GlobalSettingsSchema = z.object({
  version: z.literal(1).default(1),
  /** The REST and WebSocket port on 127.0.0.1. */
  serverPort: PortSchema.default(DEFAULT_SERVER_PORT),
  /**
   * The dev-server proxy port. It defaults to `serverPort`: the server tells
   * proxy requests apart by their `Host` header,
   * `<port>.<box>.localhost`. A different value starts a second listener.
   */
  proxyPort: PortSchema.default(DEFAULT_SERVER_PORT),
  /** The image every project container runs. */
  engineImage: z.string().min(1).default(DEFAULT_ENGINE_IMAGE),
  ceilings: CeilingsSchema.default({}),
  notifications: NotificationTogglesSchema.default({}),
  promptTemplates: PromptTemplatesSchema.default({}),
  defaultTargetDir: z.string().min(1).optional(),
  setupCompleted: z.boolean().default(false),
  /** Identity file the setup wizard checks and generates. */
  sshIdentity: z.string().min(1).optional(),
  modelCache: ModelCacheSchema.optional(),
  newBoxDefaults: NewBoxDefaultsSchema.default({}),
  /** Mounts every container gets, on top of its project's. */
  globalMounts: z.array(MountSchema).default([]),
  /** Secrets every container gets. A project's reference of the same name wins. */
  secretRefs: z.array(SecretRefSchema).default([]),
});
export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;
