// Persistent records: projects, boxes, SSH remotes, and settings.
//
// The server stores these in SQLite (`~/.ai-orchestrator/aio.db`). The
// one-time import reads the 3.3.5 key-value files, so every field below maps
// to a key of the 3.3.5 record files.
//
// Each record has two schemas. The read schema (`BoxSchema`, `ProjectSchema`,
// `SshRemoteSchema`, `GlobalSettingsSchema`) has no defaults: a stored or
// returned record carries every field. The input schema (`BoxInputSchema` and
// so on) fills defaults and outputs the read type; use it for the import, for
// creation, and for the configuration file.
//
// Box: `~/.ai-orchestrator/known/<container-name>` (inventory 3.1)
//
// | 3.3.5 key                | TypeScript field        | Notes                                      |
// |--------------------------|-------------------------|--------------------------------------------|
// | (file name)              | `id`                    | `aio-agent-<base>`                      |
// | (new)                    | `hostKey`               | from `deriveHostKey()`; proxy host names   |
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
// | `container`              | `container`             | absent (classic box): `projectContainerName(projectId)` |
// | `session`                | `session`               | absent (classic box): the box id, as `adopt()` set it |
// | `ssh_remote_ref` (rep.)  | `sshRemoteRefs`         | SSH remote names                           |
// | `yolo`                   | `skipPermissions`       | `1` means true; absent means true          |
// | `was_running`            | `wasRunning`            |                                            |
// | `port` (rep.)            | `Project.tcpMaps`       | see "Import rules"                         |
// | `dir` (rep.)             | `Project.mounts`        | see "Import rules"                         |
// | `ssh_remote`, `ssh_identity`, `ssh_forward`, `ssh_host` | `SshRemote` | legacy inline remote, imported as a named remote |
// | `rc`                     | (ignored)               |                                            |
// | (new)                    | `projectId`, `createdAt`, `updatedAt` |                              |
//
// Project: `~/.ai-orchestrator/projects/<id>` (inventory 3.2)
//
// | 3.3.5 key            | TypeScript field | Notes                                         |
// |----------------------|------------------|-----------------------------------------------|
// | (file name)          | `id`             | `slug(basename)-<sha1(root)[0:8]>`            |
// | `root`               | `root`           | normalized, no trailing slash                 |
// | `name`               | `name`           | empty means the folder name                   |
// | `primary_repo`       | `primaryRepo`    | defaults to `root` when `root/.git` exists    |
// | `dir` (rep.)         | `mounts`         | `HOST[:CONTAINER]`; container defaults to host |
// | `port` (rep.)        | (dropped)        | the 10-port pool; replaced by `tcpMaps`       |
// | `shared_container`   | (dropped)        | every project runs one shared container       |
// | (new)                | `tcpMaps`, `secretRefs`, `ceilingsOverride`, `policyPath`, `createdAt`, `updatedAt` |
//
// Import rules:
//
// - A box `port=HOST:CONTAINER` that is not in its project's `port=` pool
//   becomes a `tcpMaps` entry on the project. Ports in the pool are dropped,
//   because the engine proxies dev servers without them.
// - A box `dir=` merges into its project's `mounts`. When two mounts name the
//   same container path, the first one wins (project mounts first, then boxes
//   in record-file order), and the import reports each mount it skipped.
//
// SSH remote: `~/.ai-orchestrator/ssh_remotes/<sanitized>` (inventory 3.3)
//
// | 3.3.5 key         | TypeScript field |
// |-------------------|------------------|
// | `name`            | `name`           |
// | `host`            | `host`           |
// | `identity`        | `identity`       |
// | `forward` (rep.)  | `forwards`       |
//
// Global settings: `~/.ai-orchestrator/global` and QSettings (inventory 3.3, 3.4)
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
import { MachineRoleSchema } from "./machines.js";
import {
  AccountIdSchema,
  EffortSchema,
  EnvVarNameSchema,
  FractionSchema,
  IsoDateTimeSchema,
  PlatformSchema,
  PortSchema,
  type Platform,
} from "./common.js";
import { DEFAULT_PROMPT_TEMPLATES } from "./prompts.js";
import { isUncPath, type HostOs } from "./containerPaths.js";
import { BrokerTransportSettingSchema } from "./broker.js";

/** Every shared container name and box id starts with this prefix. */
export const CONTAINER_PREFIX = "aio-agent-";

/** Returns the shared container name for a project: `aio-agent-proj-<id>`. */
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

// Docker reads a bind as `HOST:CONTAINER[:OPTIONS]`, and the server keeps
// binds one per line, so neither side can hold a colon (other than a Windows
// drive letter's) or a control character.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Why a host directory can't be bound into a container, or `null` when it
 * can: it must be absolute (`/...`, or `C:\...` on Windows), with no colon
 * after the drive letter and no control character. A UNC network path
 * (`\\server\share`) isn't supported; without `os`, only its backslash form
 * reads as one, since `//data` is a valid POSIX path. With `os`, the path must also have
 * that OS's form: a drive letter on Windows, a leading `/` elsewhere.
 */
export function hostPathProblem(p: string, os?: HostOs): string | null {
  if (CONTROL_CHARS.test(p)) return `${JSON.stringify(p)} contains a control character.`;
  if (isUncPath(p) && (os === "win32" || p.startsWith("\\")))
    return `${p} is a UNC network path, which can't be mounted yet. Map the share to a drive letter.`;
  const bare = /^[\\/]{2}\?[\\/][A-Za-z]:/.test(p) ? p.slice(4) : p;
  const drive = /^[A-Za-z]:[\\/]/.test(bare);
  if (!drive && !bare.startsWith("/")) return `${p} is not an absolute path.`;
  if (os === "win32" && !drive)
    return `${p} is not an absolute Windows path. Start it with a drive letter, such as C:\\.`;
  if (os !== undefined && os !== "win32" && drive) return `${p} is not an absolute path.`;
  if (bare.slice(drive ? 2 : 0).includes(":"))
    return `${p} contains a colon, which Docker can't bind.`;
  return null;
}

/**
 * Why a path can't be a mount point in the container, or `null` when it can:
 * it must be absolute, not `/` itself, and hold no colon or control
 * character.
 */
export function containerPathProblem(p: string): string | null {
  if (CONTROL_CHARS.test(p)) return `${JSON.stringify(p)} contains a control character.`;
  if (!p.startsWith("/")) return `The container path ${p} is not absolute.`;
  if (p.replace(/\/+$/, "") === "") return "The container path can't be /.";
  if (p.includes(":")) return `The container path ${p} contains a colon, which Docker can't bind.`;
  return null;
}

/** Why a mount can't be bound, or `null` when it can; `os` as for `hostPathProblem()`. */
export function mountProblem(m: Mount, os?: HostOs): string | null {
  return hostPathProblem(m.host, os) ?? containerPathProblem(m.container);
}

/**
 * An explicit `HOST:CONTAINER` TCP port map for a project's container. The
 * host port listens on 127.0.0.1 unless `allInterfaces` is true, which
 * publishes it on every host interface, reachable from the network.
 */
export const TcpMapSchema = z.object({
  host: PortSchema,
  container: PortSchema,
  allInterfaces: z.boolean().optional(),
});
export type TcpMap = z.infer<typeof TcpMapSchema>;

/** A 1Password reference in the form `op://VAULT/ITEM/FIELD`. */
export const OpReferenceSchema = z.string().regex(/^op:\/\/[^/]+\/[^/]+\/.+$/, {
  message: "must have the form op://VAULT/ITEM/FIELD",
});

/**
 * What a hub lets one enrolled machine reach over the link. The hub refuses
 * everything that the grant doesn't name. See docs/multi-host.md.
 */
export const NodeGrantSchema = z.preprocess(
  (value) => {
    // Older settings can hold `signInUpdates`, from when a node could overwrite
    // the hub's sign-ins. Sign-ins only flow from the hub now, so the field
    // means nothing and must not stop stored settings from parsing.
    if (typeof value !== "object" || value === null || !("signInUpdates" in value)) return value;
    const { signInUpdates: _removed, ...rest } = value as Record<string, unknown>;
    return rest;
  },
  z
    .object({
      /** The exact `op://` references the machine may read through the hub. */
      opRefs: z.array(OpReferenceSchema).default([]),
      /** The vaults whose item and field names the machine may list through the hub. */
      opVaults: z.array(z.string().min(1)).default([]),
      /** The keys of the sign-in files the hub copies to the machine. */
      signInCopies: z.array(z.string().min(1)).default([]),
    })
    .strict(),
);
export type NodeGrant = z.infer<typeof NodeGrantSchema>;

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

/** Ceilings per vendor. */
export const CeilingsSchema = z.object({
  claude: CeilingSchema,
  codex: CeilingSchema,
  copilot: CeilingSchema,
});
export type Ceilings = z.infer<typeof CeilingsSchema>;

/** Ceilings per vendor; each missing vendor gets its default on its own. */
export const CeilingsInputSchema = z.object({
  claude: CeilingSchema.default(DEFAULT_CEILINGS.claude),
  codex: CeilingSchema.default(DEFAULT_CEILINGS.codex),
  copilot: CeilingSchema.default(DEFAULT_CEILINGS.copilot),
});

/** Only the vendors it lists change: a project override, or a settings patch. */
export const CeilingsOverrideSchema = z.object({
  claude: CeilingSchema.optional(),
  codex: CeilingSchema.optional(),
  copilot: CeilingSchema.optional(),
});
export type CeilingsOverride = z.infer<typeof CeilingsOverrideSchema>;

// ---------------------------------------------------------------------------
// Project

/** The project path, relative to the project root, of the default policy file. */
export const DEFAULT_POLICY_PATH = ".aio/policy.yaml";

/** Settings a person edits on a project. */
export const ProjectSettingsSchema = z.object({
  /** Explicit TCP maps. Dev servers need none: the engine proxies them. */
  tcpMaps: z.array(TcpMapSchema),
  /** Bind mounts on top of the project root and the global mounts. */
  mounts: z.array(MountSchema),
  /** Secrets injected into the project's container at launch. */
  secretRefs: z.array(SecretRefSchema),
  /** Per-vendor ceilings that replace the global ones for runs in this project. */
  ceilingsOverride: CeilingsOverrideSchema.optional(),
  /** Policy file path, relative to `root` unless absolute. */
  policyPath: z.string().min(1),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

const projectFields = {
  /** `slug(basename(root))-<first 8 hex digits of sha1(root)>`; ASCII letters and digits, case kept. */
  id: z.string().regex(/^[A-Za-z0-9-]+-[0-9a-f]{8}$/),
  root: z.string().min(1),
  name: z.string().min(1),
  primaryRepo: z.string().min(1).optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
};

/**
 * A project: a directory whose boxes share one container,
 * `projectContainerName(id)`. A project exists as soon as a box's
 * `targetDir` points at its root.
 */
export const ProjectSchema = ProjectSettingsSchema.extend(projectFields);
export type Project = z.infer<typeof ProjectSchema>;

/** A project with its settings defaulted. Outputs a `Project`. */
export const ProjectInputSchema = ProjectSchema.extend({
  tcpMaps: z.array(TcpMapSchema).default([]),
  mounts: z.array(MountSchema).default([]),
  secretRefs: z.array(SecretRefSchema).default([]),
  policyPath: z.string().min(1).default(DEFAULT_POLICY_PATH),
});

// ---------------------------------------------------------------------------
// SSH remotes

/**
 * One SSH port forward. The 3.3.5 file stores it as
 * `L|R:bindAddr:bindPort:destHost:destPort`.
 */
export const SshForwardSchema = z.object({
  direction: z.enum(["L", "R"]),
  bindAddress: z.string().min(1),
  bindPort: PortSchema,
  destHost: z.string().min(1),
  destPort: PortSchema,
});
export type SshForward = z.infer<typeof SshForwardSchema>;

/** A named SSH remote. Boxes refer to it by `name` in `sshRemoteRefs`. */
export const SshRemoteSchema = z.object({
  name: z.string().min(1),
  /** `user@host[:port]`; an IPv6 address takes a port only in brackets, `user@[ADDR]:port`. */
  host: z.string().min(1),
  /** Path to the identity file on the host. */
  identity: z.string().min(1).optional(),
  forwards: z.array(SshForwardSchema),
});
export type SshRemote = z.infer<typeof SshRemoteSchema>;

/**
 * Why an SSH remote's `host` is unsafe or unusable, or `null` when it is
 * fine: it must not start with `-`, which `ssh` would read as an option,
 * and holds no whitespace or control character.
 */
export function sshHostProblem(host: string): string | null {
  if (host.startsWith("-")) return `The SSH host ${host} starts with "-".`;
  if (/\s/.test(host) || CONTROL_CHARS.test(host))
    return "The SSH host contains a space or a control character.";
  const at = host.lastIndexOf("@");
  const hostPart = host.slice(at + 1);
  if (hostPart === "" || hostPart.startsWith("-"))
    return `The SSH host ${host} has no usable host name.`;
  return null;
}

/** Why an identity file path is unsafe, or `null` when it is fine. */
export function sshIdentityProblem(identity: string): string | null {
  if (identity.startsWith("-")) return `The identity file ${identity} starts with "-".`;
  if (CONTROL_CHARS.test(identity)) return "The identity file path contains a control character.";
  return null;
}

/**
 * An SSH remote with defaults: no forwards, and `localhost` bind addresses.
 * The host and the identity file are checked here, on the way in, rather
 * than in `SshRemoteSchema`, so a record stored before the check still loads.
 */
export const SshRemoteInputSchema = SshRemoteSchema.extend({
  host: z
    .string()
    .min(1)
    .superRefine((h, ctx) => {
      const problem = sshHostProblem(h);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    }),
  identity: z
    .string()
    .min(1)
    .superRefine((i, ctx) => {
      const problem = sshIdentityProblem(i);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    })
    .optional(),
  forwards: z
    .array(SshForwardSchema.extend({ bindAddress: z.string().min(1).default("localhost") }))
    .default([]),
});

// ---------------------------------------------------------------------------
// Box

/**
 * A short name for a box in proxy host names, `<port>.<hostKey>.localhost`:
 * lowercase ASCII letters, digits, and inner hyphens, at most 30 characters,
 * unique within a project.
 */
export const HostKeySchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/);

/**
 * Derives a box's `hostKey` from its id: drops the `aio-agent-` prefix,
 * lowercases, turns every other character into a hyphen, collapses and trims
 * hyphens, and cuts to 30 characters. When the key is in `taken`, it appends
 * `-2`, `-3`, and so on, cutting the stem to keep 30 characters.
 */
export function deriveHostKey(boxId: string, taken: ReadonlySet<string> = new Set()): string {
  const base = boxId.startsWith(CONTAINER_PREFIX) ? boxId.slice(CONTAINER_PREFIX.length) : boxId;
  const clean = (s: string) => s.replace(/-+/g, "-").replace(/^-|-$/g, "");
  const stem = clean(clean(base.toLowerCase().replace(/[^a-z0-9]/g, "-")).slice(0, 30)) || "box";
  if (!taken.has(stem)) return stem;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${clean(stem.slice(0, 30 - suffix.length))}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The account each CLI uses for a box, by vendor. An absent vendor means the
 * global default (`GlobalSettings.accountDefaults`). The entry for
 * `box.platform` is the main session's account; the others serve its side
 * sessions.
 */
export const BoxAccountsSchema = z
  .object({
    claude: vendorAccountId("claude").optional(),
    codex: vendorAccountId("codex").optional(),
    copilot: vendorAccountId("copilot").optional(),
  })
  .strict();
export type BoxAccounts = z.infer<typeof BoxAccountsSchema>;

/** Changes to `BoxAccounts`: `null` clears a vendor's entry. */
export const BoxAccountsPatchSchema = z
  .object({
    claude: vendorAccountId("claude").nullable(),
    codex: vendorAccountId("codex").nullable(),
    copilot: vendorAccountId("copilot").nullable(),
  })
  .partial()
  .strict();
export type BoxAccountsPatch = z.infer<typeof BoxAccountsPatchSchema>;

/**
 * A box: one conversation, run as a tmux session in its project's container.
 *
 * A box's working directory is `worktree` when set, else `targetDir` (see
 * `boxWorkDir()`). Transcript lookups and the session's working directory
 * use it, never `targetDir`. A side session for platform `p` is the tmux
 * session `<session>-<p>`. Whether a run holds the box is not stored: the
 * server derives `BoxView.reviewState` from the active runs.
 */
export const BoxSchema = z.object({
  /** The box name, `aio-agent-<base>`; the 3.3.5 record's file name. */
  id: z.string().startsWith(CONTAINER_PREFIX),
  projectId: z.string().min(1),
  hostKey: HostKeySchema,
  targetDir: z.string().min(1),
  /** Claude's session id. `null` starts a new conversation on the next start. */
  sessionUuid: z.string().uuid().nullable(),
  conversationName: z.string(),
  /** The transcript title last copied into `conversationName`. */
  transcriptSyncedName: z.string(),
  platform: PlatformSchema,
  /** `--model`; absent means the settings files decide. */
  model: z.string().min(1).optional(),
  /** `--effort`; absent means the settings files decide. */
  effort: EffortSchema.optional(),
  /** Passes `--allow-dangerously-skip-permissions`. 3.3.5 key `yolo`. */
  skipPermissions: z.boolean(),
  /** The account of each vendor; see `BoxAccountsSchema`. Absent: the defaults. */
  accounts: BoxAccountsSchema.optional(),
  /** Workspace subfolder the opening prompt names. */
  workspace: z.string().min(1).optional(),
  /** Git worktree path. When set, the box runs there. */
  worktree: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  /** Old workspace folder after Convert to Worktree, until the next start. */
  movedFrom: z.string().min(1).optional(),
  /** The project's shared container, `projectContainerName(projectId)`. */
  container: z.string().startsWith(CONTAINER_PREFIX),
  /** The tmux session inside `container`. */
  session: z.string().min(1),
  launchedModel: z.string().min(1).optional(),
  launchedEffort: EffortSchema.optional(),
  /**
   * What the first start of a box created without a start needs: the
   * opening prompt, and the conversation to fork from. That start clears it.
   */
  firstStart: z
    .object({
      openingPrompt: z.string(),
      forkFrom: z.object({ uuid: z.string().uuid(), workDir: z.string().min(1) }).optional(),
    })
    .optional(),
  wasRunning: z.boolean(),
  sshRemoteRefs: z.array(z.string().min(1)),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Box = z.infer<typeof BoxSchema>;

/** A box with the 3.3.5 defaults filled. Outputs a `Box`. */
export const BoxInputSchema = BoxSchema.extend({
  sessionUuid: z.string().uuid().nullable().default(null),
  conversationName: z.string().default(""),
  transcriptSyncedName: z.string().default(""),
  platform: PlatformSchema.default("claude"),
  skipPermissions: z.boolean().default(true),
  wasRunning: z.boolean().default(false),
  sshRemoteRefs: z.array(z.string().min(1)).default([]),
});
export type BoxInput = z.input<typeof BoxInputSchema>;

/** Returns the directory a box's agent works in: the worktree, else the target directory. */
export function boxWorkDir(box: Pick<Box, "worktree" | "targetDir">): string {
  return box.worktree ?? box.targetDir;
}

// ---------------------------------------------------------------------------
// Global settings

/** Which events raise a desktop notification. */
export const NotificationTogglesSchema = z.object({
  decisionNeeded: z.boolean(),
  runFinished: z.boolean(),
  /** A run passed review and its branch is ready to push (`ready_to_push`). */
  readyToPush: z.boolean(),
  boxEnded: z.boolean(),
  roundSummary: z.boolean(),
});
export type NotificationToggles = z.infer<typeof NotificationTogglesSchema>;

/**
 * Prompt templates. An empty string turns a template off; 3.3.5 could not
 * turn the Starter off (inventory section 0, item 3).
 */
export const PromptTemplatesSchema = z.object({
  workspace: z.string(),
  worktree: z.string(),
  portHint: z.string(),
  starter: z.string(),
});
export type PromptTemplates = z.infer<typeof PromptTemplatesSchema>;

/** The model list scanned from the engine image, cached against the image id. */
export const ModelCacheSchema = z.object({
  imageId: z.string().min(1),
  scannedAt: IsoDateTimeSchema,
  models: z.array(z.string().min(1)),
});
export type ModelCache = z.infer<typeof ModelCacheSchema>;

/** Per-directory defaults for the New Box form's `layout: "auto"`. */
export const NewBoxDefaultsSchema = z.object({
  /** Directory to whether a new box gets a workspace subfolder. */
  workspaceDirs: z.record(z.string(), z.boolean()),
  /** Directory to whether a new box gets a worktree. */
  worktreeDirs: z.record(z.string(), z.boolean()),
});
export type NewBoxDefaults = z.infer<typeof NewBoxDefaultsSchema>;

/**
 * The model, and for Claude the effort, that review agents of each vendor use
 * when a run doesn't name one. An absent `model` or `effort` leaves the
 * choice to the vendor CLI's own settings. Copilot always passes `--model`,
 * so its model is required; `auto` lets Copilot pick.
 */
export const VendorDefaultsSchema = z.object({
  claude: z.object({
    model: z.string().min(1).optional(),
    effort: EffortSchema.optional(),
  }),
  codex: z.object({ model: z.string().min(1).optional() }),
  copilot: z.object({ model: z.string().min(1) }),
});
export type VendorDefaults = z.infer<typeof VendorDefaultsSchema>;

/** See `GlobalSettings.accountsMode`. */
export const AccountsModeSchema = z.enum(["host", "accounts"]);
export type AccountsMode = z.infer<typeof AccountsModeSchema>;

/** An account id of one vendor: `VENDOR/NAME` with that `VENDOR`. */
export function vendorAccountId(vendor: Platform) {
  return AccountIdSchema.refine((id) => id.startsWith(`${vendor}/`), {
    message: `must be a ${vendor} account id, such as ${vendor}/personal`,
  });
}

/** The default account of each vendor. An absent vendor has no default yet. */
export const AccountDefaultsSchema = z
  .object({
    claude: vendorAccountId("claude").optional(),
    codex: vendorAccountId("codex").optional(),
    copilot: vendorAccountId("copilot").optional(),
  })
  .strict();
export type AccountDefaults = z.infer<typeof AccountDefaultsSchema>;

/** The Copilot model when the settings name none. */
export const DEFAULT_COPILOT_MODEL = "auto";

export const DEFAULT_SERVER_PORT = 21400;
export const DEFAULT_ENGINE_PORT = 20411;
export const DEFAULT_ENGINE_IMAGE = "aio-agent";

/**
 * A machine name: what a node enrolls under, and the `MACHINE` in
 * machine-qualified box IDs. Letters, digits, dots, and hyphens, starting
 * with a letter or digit.
 */
export const MachineNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/, "Use letters, digits, dots, and hyphens.");

/**
 * Global settings. The server stores them in its database. On the first
 * start, when the database holds no settings yet, the server seeds them from
 * `~/.ai-orchestrator/config.json` through `GlobalSettingsInputSchema`, and reads
 * that file never again. Unknown keys are rejected.
 */
export const GlobalSettingsSchema = z
  .object({
    version: z.literal(1),
    /** The HTTPS REST and WebSocket port on 127.0.0.1. */
    serverPort: PortSchema,
    /**
     * The dev-server proxy port, a plain HTTP listener on 127.0.0.1 that
     * serves `http://<port>.<hostKey>.localhost:<proxyPort>/`. Absent, or
     * equal to `serverPort`, means the port after `serverPort`; see
     * `proxyPortOf()`.
     */
    proxyPort: PortSchema.optional(),
    /** The image every project container runs. */
    engineImage: z.string().min(1),
    ceilings: CeilingsSchema,
    vendorDefaults: VendorDefaultsSchema,
    notifications: NotificationTogglesSchema,
    promptTemplates: PromptTemplatesSchema,
    defaultTargetDir: z.string().min(1).optional(),
    setupCompleted: z.boolean(),
    /** Identity file the setup wizard checks and generates. */
    sshIdentity: z.string().min(1).optional(),
    modelCache: ModelCacheSchema.optional(),
    newBoxDefaults: NewBoxDefaultsSchema,
    /** Mounts every container gets, on top of its project's. */
    globalMounts: z.array(MountSchema),
    /** Secrets every container gets. A project's reference of the same name wins. */
    secretRefs: z.array(SecretRefSchema),
    /**
     * The 1Password vaults the secrets picker lists. Empty means the vaults
     * that existing references name, else `Aio`.
     */
    secretVaults: z.array(z.string().min(1)),
    /**
     * The 1Password reference of the container user's sudo password. Absent
     * means sudo is off in every container. The server installs only a hash
     * of the value; see docs/secrets.md.
     */
    sudoPasswordRef: OpReferenceSchema.optional(),
    /**
     * Where boxes get the agent CLIs' config folders: `host` mounts the
     * host's `~/.claude`, `~/.claude.json`, `~/.codex`, and `~/.copilot`;
     * `accounts` uses the account folders. Phase 1
     * stores the setting, but every launch still uses the host folders.
     */
    accountsMode: AccountsModeSchema,
    /** The default account of each vendor, by account id. */
    accountDefaults: AccountDefaultsSchema,
    /**
     * An override for the shared Claude transcript store. Absent means
     * `DATA_DIR/transcripts/claude`.
     */
    transcriptStore: z.string().min(1).optional(),
    /**
     * The least `cleanupPeriodDays` that AI Orchestrator keeps in every Claude
     * account's `settings.json`, unless the host's `~/.claude/settings.json`
     * sets one, which wins. Absent means 3650.
     */
    transcriptRetentionDays: z.number().int().positive().optional(),
    /**
     * How many hard-link snapshots of the transcript store to keep under
     * `DATA_DIR/backup/transcripts`. Absent means 7; 0 turns snapshots off.
     */
    transcriptBackupKeep: z.number().int().nonnegative().optional(),
    /**
     * How the secrets broker reaches containers; see
     * `BrokerTransportSettingSchema`. Absent means `auto`.
     */
    brokerTransport: BrokerTransportSettingSchema.optional(),
    /**
     * This machine's role in a multi-host setup: `hub`, `node`, or `both`.
     * Absent means `both`, a single machine. `aio-server --role` and
     * `AIO_ROLE` override it for one run. See docs/multi-host.md.
     */
    role: MachineRoleSchema.optional(),
    /** The name this machine shows and enrolls under. Absent means the host name. */
    machineName: MachineNameSchema.optional(),
    /**
     * The port a hub listens on for node links. Absent means
     * `DEFAULT_LINK_PORT`, 21402.
     */
    linkPort: PortSchema.optional(),
    /**
     * The port a hub listens on for GUI apps on other PCs. Absent means
     * `DEFAULT_GUI_PORT`, 21403.
     */
    guiPort: PortSchema.optional(),
    /**
     * The address a hub's link listener binds. Absent means the primary LAN
     * IPv4 address: the private address of the interface that holds the
     * default route. With no such address, the listener doesn't start.
     */
    linkHost: z.string().min(1).optional(),
    /**
     * The host name or address that nodes use to reach this hub, for the
     * hub URL in enrollment codes. Absent means the address the listener
     * binds.
     */
    linkAddress: z.string().min(1).optional(),
    /** On a hub, what each enrolled machine may reach, by machine ID. Absent grants nothing. */
    nodeGrants: z.record(z.string().min(1), NodeGrantSchema).optional(),
  })
  .strict();
export type GlobalSettings = z.infer<typeof GlobalSettingsSchema>;

/** The port a hub listens on for node links when the settings name none. */
export const DEFAULT_LINK_PORT = 21402;
/** The port a hub's GUI listener uses by default. */
export const DEFAULT_GUI_PORT = 21403;

/**
 * The dev-server proxy's port: `proxyPort`, else the port after
 * `serverPort`. The API listener serves HTTPS with a certificate for
 * loopback only, so the proxy's `*.localhost` names need a listener of their
 * own; a `proxyPort` equal to `serverPort`, which pre-release development builds
 * allowed, counts as absent.
 */
export function proxyPortOf(settings: Pick<GlobalSettings, "serverPort" | "proxyPort">): number {
  const { serverPort, proxyPort } = settings;
  if (proxyPort !== undefined && proxyPort !== serverPort) return proxyPort;
  return serverPort < 65535 ? serverPort + 1 : serverPort - 1;
}

/**
 * The configuration file's content with every missing field defaulted, so
 * `{}` parses to a complete `GlobalSettings`. Unknown keys are rejected.
 */
export const GlobalSettingsInputSchema = z
  .object({
    ...GlobalSettingsSchema.shape,
    version: z.literal(1).default(1),
    serverPort: PortSchema.default(DEFAULT_SERVER_PORT),
    engineImage: z.string().min(1).default(DEFAULT_ENGINE_IMAGE),
    ceilings: CeilingsInputSchema.default({}),
    vendorDefaults: z
      .object({
        claude: VendorDefaultsSchema.shape.claude.default({}),
        codex: VendorDefaultsSchema.shape.codex.default({}),
        copilot: z.object({ model: z.string().min(1).default(DEFAULT_COPILOT_MODEL) }).default({}),
      })
      .default({}),
    notifications: z
      .object({
        decisionNeeded: z.boolean().default(true),
        runFinished: z.boolean().default(true),
        readyToPush: z.boolean().default(true),
        boxEnded: z.boolean().default(true),
        roundSummary: z.boolean().default(true),
      })
      .default({}),
    promptTemplates: z
      .object({
        workspace: z.string().default(DEFAULT_PROMPT_TEMPLATES.workspace),
        worktree: z.string().default(DEFAULT_PROMPT_TEMPLATES.worktree),
        portHint: z.string().default(DEFAULT_PROMPT_TEMPLATES.portHint),
        starter: z.string().default(DEFAULT_PROMPT_TEMPLATES.starter),
      })
      .default({}),
    setupCompleted: z.boolean().default(false),
    newBoxDefaults: z
      .object({
        workspaceDirs: z.record(z.string(), z.boolean()).default({}),
        worktreeDirs: z.record(z.string(), z.boolean()).default({}),
      })
      .default({}),
    globalMounts: z.array(MountSchema).default([]),
    secretRefs: z.array(SecretRefSchema).default([]),
    secretVaults: z.array(z.string().min(1)).default([]),
    accountsMode: AccountsModeSchema.default("host"),
    accountDefaults: AccountDefaultsSchema.default({}),
    transcriptStore: z.string().min(1).optional(),
    transcriptRetentionDays: z.number().int().positive().optional(),
    transcriptBackupKeep: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * The body of `PATCH /api/v1/settings`: only the fields a person edits there,
 * with no defaults. The server owns `version`, `serverPort`, `setupCompleted`,
 * `modelCache`, and `newBoxDefaults`; prompt templates, global mounts, and
 * secret references have their own routes. A patch that names any of them is
 * rejected. `null` clears an optional field.
 */
export const GlobalSettingsPatchSchema = z
  .object({
    proxyPort: PortSchema.nullable(),
    engineImage: z.string().min(1),
    ceilings: CeilingsOverrideSchema,
    /** Only the vendors and fields it names change; `null` clears a model or an effort. */
    vendorDefaults: z
      .object({
        claude: z
          .object({
            model: z.string().min(1).nullable(),
            effort: EffortSchema.nullable(),
          })
          .partial()
          .strict(),
        codex: z
          .object({ model: z.string().min(1).nullable() })
          .partial()
          .strict(),
        copilot: z
          .object({ model: z.string().min(1) })
          .partial()
          .strict(),
      })
      .partial()
      .strict(),
    notifications: NotificationTogglesSchema.partial(),
    defaultTargetDir: z.string().min(1).nullable(),
    sshIdentity: z.string().min(1).nullable(),
    sudoPasswordRef: OpReferenceSchema.nullable(),
    secretVaults: z.array(z.string().min(1)),
    accountsMode: AccountsModeSchema,
    /** An absolute folder; `null` goes back to the host's store. */
    transcriptStore: z.string().min(1).nullable(),
    /** `null` goes back to the default, 3650 days. */
    transcriptRetentionDays: z.number().int().positive().nullable(),
    /** `0` turns snapshots off; `null` goes back to the default, 7. */
    transcriptBackupKeep: z.number().int().nonnegative().nullable(),
    /** Takes effect at the next server start, except for the node link. */
    role: MachineRoleSchema,
    /** `null` goes back to the host name. */
    machineName: MachineNameSchema.nullable(),
    /** `null` goes back to 21402. Takes effect when the link listener next starts. */
    linkPort: PortSchema.nullable(),
    /** `null` goes back to 21403. Takes effect when the GUI listener next starts. */
    guiPort: PortSchema.nullable(),
    /** `null` goes back to the LAN address. Takes effect when the link listener next starts. */
    linkHost: z.string().min(1).nullable(),
    /** `null` goes back to the address the link listener binds. */
    linkAddress: z.string().min(1).nullable(),
    /** Replaces every machine's grant; `null` removes them all. */
    nodeGrants: z.record(z.string().min(1), NodeGrantSchema).nullable(),
    /**
     * Applies to containers created afterward; `null` goes back to `auto`.
     */
    brokerTransport: BrokerTransportSettingSchema.nullable(),
    /**
     * Only the vendors it names change; `null` clears a default. The server
     * refuses an id that names no account.
     */
    accountDefaults: z
      .object({
        claude: vendorAccountId("claude").nullable(),
        codex: vendorAccountId("codex").nullable(),
        copilot: vendorAccountId("copilot").nullable(),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();
export type GlobalSettingsPatch = z.infer<typeof GlobalSettingsPatchSchema>;
