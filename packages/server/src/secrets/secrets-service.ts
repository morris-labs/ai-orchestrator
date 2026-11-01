// Resolves secret references for the secrets broker and for the pre-start
// check of a container launch, and reports which references resolve. Values
// leave this module only through `readNames`, which the broker calls for a
// container that asks. The sudo password never leaves it at all:
// `sudoPasswordHash` returns only its SHA-512 crypt hash, and the password
// never enters the cache.
import type {
  GlobalSettings,
  SecretCandidate,
  SecretRef,
  SecretsAvailable,
  SecretsCheckResultSchema,
  SecretsViewSchema,
} from "@agentbox/contracts";
import type { z } from "zod";
import { ApiError, toApiError } from "../api/errors.js";
import { hashSudoPassword } from "./crypt.js";
import type { OpClient, OpItemInfo } from "./op.js";

export type SecretsCheckResult = z.infer<typeof SecretsCheckResultSchema>;
export type SecretsView = z.infer<typeof SecretsViewSchema>;

/** The default time a resolved value stays in the cache: 5 minutes. */
export const SECRET_CACHE_TTL_MS = 5 * 60_000;

export interface SecretsServiceOptions {
  op: OpClient;
  settings: () => GlobalSettings;
  /** The project's references; throws `not_found` for an unknown project. */
  projectRefs: (projectId: string) => Promise<SecretRef[]>;
  listProjects: () => Promise<{ projectId: string; refs: SecretRef[] }[]>;
  /** How long a resolved value stays cached, in milliseconds. Default: `SECRET_CACHE_TTL_MS`. */
  cacheTtlMs?: number;
  /** The clock in milliseconds; tests replace it. Default: `Date.now`. */
  now?: () => number;
}

/**
 * Merges global and project references by variable name. A project's
 * reference wins over a global one of the same name.
 */
export function mergeSecretRefs(global: SecretRef[], project: SecretRef[]): SecretRef[] {
  const byName = new Map<string, SecretRef>();
  for (const ref of global) byName.set(ref.name, ref);
  for (const ref of project) byName.set(ref.name, ref);
  return [...byName.values()];
}

export class SecretsService {
  /** Values by reference, each until its expiry time. Failed reads aren't kept. */
  private cache = new Map<string, { value: Promise<string>; expiresAt: number }>();

  constructor(private readonly opts: SecretsServiceOptions) {}

  /** The available-fields list by vault set, each until its expiry time. Metadata only. */
  private availableCache = new Map<
    string,
    { value: Promise<SecretsAvailable>; expiresAt: number }
  >();

  clearCache(): void {
    this.cache = new Map();
    this.availableCache = new Map();
  }

  /**
   * The vaults to search: the `secretVaults` setting, else the vaults that
   * global and project references name, else `AgentBox`.
   */
  async searchedVaults(): Promise<string[]> {
    const configured = this.opts.settings().secretVaults;
    if (configured.length > 0) return [...new Set(configured)];
    const refs = [
      ...this.opts.settings().secretRefs,
      ...(await this.opts.listProjects()).flatMap((p) => p.refs),
    ];
    const used = new Set<string>();
    for (const r of refs) {
      const v = vaultOf(r.ref);
      if (v) used.add(v);
    }
    return used.size > 0 ? [...used].sort() : [DEFAULT_SECRET_VAULT];
  }

  /**
   * Lists the 1Password fields a project can reference, with a proposed
   * variable name each. Never holds a value. The list stays cached for 30
   * seconds; `refresh` bypasses the cache. Throws `secrets_locked` or
   * `secrets_unavailable` when `op` is signed out or missing, or when every
   * vault fails; a vault that fails alone is reported in `vaultErrors`.
   */
  async available(refresh = false): Promise<SecretsAvailable> {
    const vaults = await this.searchedVaults();
    const key = vaults.join("\n");
    const now = (this.opts.now ?? Date.now)();
    const hit = this.availableCache.get(key);
    if (!refresh && hit && hit.expiresAt > now) return hit.value;
    const value = this.listAvailable(vaults, now);
    const entry = { value, expiresAt: now + AVAILABLE_CACHE_TTL_MS };
    this.availableCache.set(key, entry);
    // A failure isn't cached: the next request asks 1Password again.
    value.catch(() => {
      if (this.availableCache.get(key) === entry) this.availableCache.delete(key);
    });
    return value;
  }

  private async listAvailable(vaults: string[], now: number): Promise<SecretsAvailable> {
    await this.requireSignedIn();
    const candidates: SecretCandidate[] = [];
    const vaultErrors: SecretsAvailable["vaultErrors"] = [];
    for (const vault of vaults) {
      let items: OpItemInfo[];
      try {
        items = await this.opts.op.listItems(vault);
      } catch (err) {
        const e = toApiError(err);
        if (e.code === "secrets_locked") throw e;
        vaultErrors.push({ vault, message: e.message });
        continue;
      }
      candidates.push(...candidatesFor(vault, items));
    }
    if (vaultErrors.length === vaults.length) {
      throw new ApiError("secrets_unavailable", vaultErrors.map((e) => e.message).join(" "));
    }
    return { vaults, candidates, vaultErrors, fetchedAt: new Date(now).toISOString() };
  }

  /** The global and the project's references, merged. Throws `not_found` for an unknown project. */
  async refsFor(projectId: string): Promise<SecretRef[]> {
    return mergeSecretRefs(this.opts.settings().secretRefs, await this.opts.projectRefs(projectId));
  }

  /** The variable names a container of the project may request, sorted. */
  async names(projectId: string): Promise<string[]> {
    return (await this.refsFor(projectId)).map((r) => r.name).sort();
  }

  /**
   * The pre-start check of a container launch: resolves every reference with
   * a fresh `op read`, keeps the values in the cache for the broker, and
   * returns the names, sorted. Throws `secrets_unavailable` when `op` is
   * missing or a reference doesn't resolve, and `secrets_locked` when `op`
   * is not signed in.
   */
  async preflight(projectId: string): Promise<string[]> {
    const refs = await this.refsFor(projectId);
    if (refs.length === 0) return [];
    await this.requireSignedIn();
    const fresh = new Set<string>();
    for (const ref of refs) {
      if (fresh.has(ref.ref)) continue;
      fresh.add(ref.ref);
      this.cache.delete(ref.ref);
      await this.read(ref.ref);
    }
    return refs.map((r) => r.name).sort();
  }

  /**
   * Resolves named secrets of a project for the broker. The names are
   * checked against the current references on every call, so a removed
   * reference stops resolving at once. All or nothing: throws `not_found`
   * when the project doesn't list a name, and `secrets_locked` or
   * `secrets_unavailable` when a value doesn't resolve.
   */
  async readNames(projectId: string, names: readonly string[]): Promise<Record<string, string>> {
    const byName = new Map((await this.refsFor(projectId)).map((r) => [r.name, r.ref]));
    const missing = names.filter((n) => !byName.has(n));
    if (missing.length > 0) {
      throw new ApiError(
        "not_found",
        `This project doesn't list the secret ${missing.join(", ")}. Add a reference for it in the project or global settings.`,
        { names: missing },
      );
    }
    const values: Record<string, string> = {};
    for (const name of names) values[name] = await this.read(byName.get(name)!);
    return values;
  }

  /**
   * Resolves the sudo password reference and returns the password's SHA-512
   * crypt hash, or `null` when no reference is set, which turns sudo off.
   * The plaintext stays in this function. Throws like `preflight`.
   */
  async sudoPasswordHash(): Promise<string | null> {
    const ref = this.opts.settings().sudoPasswordRef;
    if (ref === undefined) return null;
    return hashSudoPassword(await this.readSudoPassword(ref));
  }

  private async readSudoPassword(ref: string): Promise<string> {
    await this.requireSignedIn();
    const password = await this.opts.op.read(ref);
    if (password.length === 0) {
      throw new ApiError(
        "secrets_unavailable",
        `The sudo password reference ${ref} resolves to an empty value.`,
      );
    }
    if (/[\n\r]/.test(password)) {
      throw new ApiError(
        "secrets_unavailable",
        `The sudo password reference ${ref} resolves to more than one line. Use a single-line password.`,
      );
    }
    return password;
  }

  private async requireSignedIn(): Promise<void> {
    const status = await this.opts.op.status();
    if (!status.installed) {
      throw new ApiError(
        "secrets_unavailable",
        "The 1Password CLI (op) is not installed, and this launch needs secret references resolved.",
      );
    }
    if (!status.signedIn) {
      throw new ApiError(
        "secrets_locked",
        "The 1Password CLI is not signed in. Sign in with op signin or unlock the desktop app, then try again.",
      );
    }
  }

  /** One reference's value, from the cache while it's fresh, else from `op`. */
  private read(ref: string): Promise<string> {
    const now = (this.opts.now ?? Date.now)();
    const hit = this.cache.get(ref);
    if (hit && hit.expiresAt > now) return hit.value;
    const value = this.opts.op.read(ref);
    const entry = { value, expiresAt: now + (this.opts.cacheTtlMs ?? SECRET_CACHE_TTL_MS) };
    this.cache.set(ref, entry);
    // A failure isn't cached: the next request asks 1Password again.
    value.catch(() => {
      if (this.cache.get(ref) === entry) this.cache.delete(ref);
    });
    return value;
  }

  /** Tries every global reference, and the project's when given, without returning values. */
  async check(projectId?: string): Promise<SecretsCheckResult> {
    const op = await this.opts.op.status();
    const entries: { ref: SecretRef; scope: "global" | "project" }[] = [
      ...this.opts.settings().secretRefs.map((ref) => ({ ref, scope: "global" as const })),
    ];
    if (projectId !== undefined) {
      for (const ref of await this.opts.projectRefs(projectId)) {
        entries.push({ ref, scope: "project" });
      }
    }
    const results: SecretsCheckResult["results"] = [];
    for (const { ref, scope } of entries) {
      let error: string | null = null;
      if (!op.installed) error = "The 1Password CLI (op) is not installed.";
      else if (!op.signedIn) error = "The 1Password CLI is not signed in.";
      else {
        try {
          await this.opts.op.read(ref.ref);
        } catch (err) {
          error = toApiError(err).message;
        }
      }
      results.push({ name: ref.name, ref: ref.ref, scope, ok: error === null, error });
    }
    return { op, results };
  }

  async view(): Promise<SecretsView> {
    return {
      global: this.opts.settings().secretRefs,
      projects: await this.opts.listProjects(),
      op: await this.opts.op.status(),
    };
  }
}

/** The vault used when neither the setting nor an existing reference names one. */
export const DEFAULT_SECRET_VAULT = "AgentBox";

/** How long the list of available fields stays cached: 30 seconds. */
export const AVAILABLE_CACHE_TTL_MS = 30_000;

/** Proposes an environment variable name: the item and the field in upper snake case. */
export function suggestSecretName(item: string, field: string): string {
  const snake = `${item}_${field}`
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (snake === "") return "SECRET";
  return /^[0-9]/.test(snake) ? `_${snake}` : snake;
}

/** The vault of an `op://VAULT/...` reference, or `null`. */
function vaultOf(ref: string): string | null {
  const m = /^op:\/\/([^/]+)\//.exec(ref);
  return m ? m[1]! : null;
}

/** Turns the items of a vault into candidates, skipping any whose reference can't be written. */
export function candidatesFor(vault: string, items: OpItemInfo[]): SecretCandidate[] {
  if (vault.includes("/")) return [];
  const out: SecretCandidate[] = [];
  for (const item of items) {
    const itemSeg = item.title.includes("/") ? item.id : item.title;
    for (const f of item.fields) {
      // A label or section with a slash can't sit in a reference; the field id can.
      const plain = !f.label.includes("/") && !(f.section?.includes("/") ?? false);
      const fieldSeg = plain ? (f.section ? `${f.section}/${f.label}` : f.label) : f.id;
      out.push({
        vault,
        item: item.title,
        itemId: item.id,
        field: f.label,
        ...(f.section ? { section: f.section } : {}),
        type: f.type,
        ref: `op://${vault}/${itemSeg}/${fieldSeg}`,
        suggestedName: suggestSecretName(item.title, f.label),
      });
    }
  }
  return out;
}
