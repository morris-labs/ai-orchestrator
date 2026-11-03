// Global settings: stored in the database, validated by `GlobalSettingsSchema`,
// and published as `settings.changed` on every change.
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_PROMPT_TEMPLATES,
  BROKER_ENV,
  ENGINE_ENV,
  GlobalSettingsPatchSchema,
  GlobalSettingsSchema,
  MountSchema,
  PromptTemplatesSchema,
  mountProblem,
  SecretRefSchema,
  parseConfig,
  type GlobalSettings,
  type GlobalSettingsPatch,
  type ModelCache,
  type Platform,
  type Mount,
  type PromptTemplates,
  type SecretRef,
  type HostOs,
} from "@aio/contracts";
import { z } from "zod";
import type { SettingsRepo } from "../db/repositories.js";
import type { HostEnv } from "./env.js";
import { homePaths, hostOsOf } from "./env.js";
import { ApiError } from "./errors.js";
import type { CoreEvents } from "./events.js";

function parseOrThrow<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ApiError(
      "validation",
      r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      {
        issues: r.error.issues,
      },
    );
  }
  return r.data;
}

function changedKeys(before: GlobalSettings, after: GlobalSettings): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(
    (k) =>
      JSON.stringify((before as Record<string, unknown>)[k]) !==
      JSON.stringify((after as Record<string, unknown>)[k]),
  );
}

/**
 * Throws `validation` for the first mount docker can't bind: a relative or
 * colon-bearing host path, or a container path that isn't absolute.
 */
export function assertMountable(mounts: readonly Mount[], hostOs?: HostOs): void {
  for (const m of mounts) {
    const problem = mountProblem(m, hostOs);
    if (problem) throw new ApiError("validation", problem, { mount: m });
  }
}

export class SettingsService {
  constructor(
    private readonly env: HostEnv,
    private readonly repo: SettingsRepo,
    private readonly events: CoreEvents,
    /** Whether an account record exists; a patch can name only existing accounts as defaults. */
    private readonly accountExists: (id: string) => boolean = () => false,
    /**
     * Runs before the mode changes to `accounts`, with the settings that
     * would result. Throws to refuse the change.
     */
    private readonly beforeAccountsMode: (next: GlobalSettings) => void = () => undefined,
  ) {}

  /**
   * Seeds the database from `~/.ai-orchestrator/config.json` the first time, when
   * that file exists and no settings were saved yet. Returns whether it did.
   */
  seedFromConfigFile(): boolean {
    if (this.repo.exists()) return false;
    const file = homePaths(this.env).config;
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return false;
    }
    this.repo.put(parseConfig(JSON.parse(raw)), this.env.now());
    return true;
  }

  get(): GlobalSettings {
    return this.repo.get();
  }

  /** Validates and stores `next`, and publishes the keys that changed. */
  private save(next: GlobalSettings): GlobalSettings {
    const before = this.repo.get();
    const saved = this.repo.put(parseOrThrow(GlobalSettingsSchema, next), this.env.now());
    const keys = changedKeys(before, saved);
    if (keys.length > 0)
      this.events.publish({ type: "settings.changed", settings: saved, changedKeys: keys });
    return saved;
  }

  /** Applies `PATCH /api/v1/settings`. `null` clears an optional field. */
  patch(input: GlobalSettingsPatch): GlobalSettings {
    const p = parseOrThrow(GlobalSettingsPatchSchema, input);
    const next: GlobalSettings = structuredClone(this.get());
    if (p.proxyPort !== undefined) {
      if (p.proxyPort === null) delete next.proxyPort;
      else next.proxyPort = p.proxyPort;
    }
    if (p.engineImage !== undefined) next.engineImage = p.engineImage;
    if (p.ceilings !== undefined)
      next.ceilings = { ...next.ceilings, ...stripUndefined(p.ceilings) };
    if (p.vendorDefaults !== undefined) {
      const vd = p.vendorDefaults;
      for (const vendor of ["claude", "codex", "copilot"] as const) {
        const fields = vd[vendor];
        if (fields === undefined) continue;
        const target = next.vendorDefaults[vendor] as Record<string, unknown>;
        for (const [key, value] of Object.entries(fields)) {
          if (value === undefined) continue;
          if (value === null) delete target[key];
          else target[key] = value;
        }
      }
    }
    if (p.notifications !== undefined) {
      next.notifications = { ...next.notifications, ...stripUndefined(p.notifications) };
    }
    for (const key of ["defaultTargetDir", "sshIdentity", "sudoPasswordRef"] as const) {
      const v = p[key];
      if (v === undefined) continue;
      if (v === null) delete next[key];
      else next[key] = v;
    }
    if (p.secretVaults !== undefined) next.secretVaults = [...new Set(p.secretVaults)];
    if (p.transcriptStore !== undefined) {
      if (p.transcriptStore === null) delete next.transcriptStore;
      else if (!path.isAbsolute(p.transcriptStore)) {
        throw new ApiError("validation", `${p.transcriptStore} isn't an absolute path.`);
      } else next.transcriptStore = p.transcriptStore;
    }
    for (const key of ["transcriptRetentionDays", "transcriptBackupKeep"] as const) {
      const v = p[key];
      if (v === undefined) continue;
      if (v === null) delete next[key];
      else next[key] = v;
    }
    if (p.brokerTransport !== undefined) {
      if (p.brokerTransport === null || p.brokerTransport === "auto") delete next.brokerTransport;
      else next.brokerTransport = p.brokerTransport;
    }
    for (const key of [
      "machineName",
      "linkPort",
      "linkHost",
      "linkAddress",
      "nodeGrants",
    ] as const) {
      const v = p[key];
      if (v === undefined) continue;
      if (v === null) delete next[key];
      else (next as Record<string, unknown>)[key] = v;
    }
    if (p.role !== undefined) next.role = p.role;
    if (p.accountsMode !== undefined) next.accountsMode = p.accountsMode;
    if (p.accountDefaults !== undefined) {
      for (const vendor of ["claude", "codex", "copilot"] as const) {
        const id = p.accountDefaults[vendor];
        if (id === undefined) continue;
        if (id === null) {
          delete next.accountDefaults[vendor];
          continue;
        }
        if (!this.accountExists(id)) throw new ApiError("validation", `No account ${id}.`);
        next.accountDefaults[vendor] = id;
      }
    }
    if (next.accountsMode === "accounts" && this.get().accountsMode !== "accounts") {
      this.beforeAccountsMode(next);
    }
    return this.save(next);
  }

  /** Sets or, with `undefined`, clears a vendor's default account. Doesn't check the id. */
  setAccountDefault(vendor: Platform, id: string | undefined): GlobalSettings {
    const next = structuredClone(this.get());
    if (id === undefined) delete next.accountDefaults[vendor];
    else next.accountDefaults[vendor] = id;
    return this.save(next);
  }

  setPromptTemplates(templates: PromptTemplates): GlobalSettings {
    const t = parseOrThrow(PromptTemplatesSchema, templates);
    return this.save({ ...this.get(), promptTemplates: t });
  }

  /** The built-in prompt templates, for Reset to default. */
  defaultPromptTemplates(): PromptTemplates {
    return { ...DEFAULT_PROMPT_TEMPLATES };
  }

  /** Replaces the global mounts. Every host directory must exist. */
  setGlobalMounts(mounts: Mount[]): GlobalSettings {
    const list = parseOrThrow(z.array(MountSchema), mounts);
    assertMountable(list, hostOsOf(this.env));
    const missing = list.filter((m) => !isDirectory(m.host)).map((m) => m.host);
    if (missing.length > 0) {
      throw new ApiError(
        "validation",
        `These host directories do not exist: ${missing.join(", ")}.`,
        {
          missing,
        },
      );
    }
    return this.save({ ...this.get(), globalMounts: list });
  }

  setSecretRefs(refs: SecretRef[]): GlobalSettings {
    const list = parseOrThrow(z.array(SecretRefSchema), refs);
    assertUniqueNames(list);
    return this.save({ ...this.get(), secretRefs: list });
  }

  completeSetup(defaultTargetDir?: string): GlobalSettings {
    const next = { ...this.get(), setupCompleted: true };
    if (defaultTargetDir !== undefined) next.defaultTargetDir = defaultTargetDir;
    return this.save(next);
  }

  setModelCache(cache: ModelCache): GlobalSettings {
    return this.save({ ...this.get(), modelCache: cache });
  }

  /** Remembers the New Box layout choice for a directory. */
  rememberLayout(dir: string, choice: { workspace: boolean; worktree?: boolean }): GlobalSettings {
    const s = this.get();
    const defaults = structuredClone(s.newBoxDefaults);
    defaults.workspaceDirs[dir] = choice.workspace;
    if (choice.worktree !== undefined) defaults.worktreeDirs[dir] = choice.worktree;
    return this.save({ ...s, newBoxDefaults: defaults });
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Environment variables the server sets on every project container. Docker
 * keeps the last of two duplicates, so a secret with one of these names
 * would replace the server's value, such as the engine token.
 */
export const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  "IS_SANDBOX",
  "DISABLE_AUTOUPDATER",
  "GIT_CONFIG_GLOBAL",
  ...Object.values(ENGINE_ENV),
  ...Object.values(BROKER_ENV),
]);

/**
 * Refuses two references that set the same environment variable, and a
 * reference that sets one the server reserves.
 */
export function assertUniqueNames(refs: readonly SecretRef[]): void {
  const seen = new Set<string>();
  for (const r of refs) {
    if (RESERVED_ENV_NAMES.has(r.name))
      throw new ApiError(
        "validation",
        `The secret name ${r.name} is reserved for a variable the server sets.`,
      );
    if (seen.has(r.name)) throw new ApiError("validation", `The secret ${r.name} is listed twice.`);
    seen.add(r.name);
  }
}
