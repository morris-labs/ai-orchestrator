// Resolves secret references into environment variables for a container
// launch, and reports which references resolve. Values never leave this
// module except in the environment map `resolveEnv` returns.
import type {
  GlobalSettings,
  SecretRef,
  SecretsCheckResultSchema,
  SecretsViewSchema,
} from "@agentbox/contracts";
import type { z } from "zod";
import { ApiError, toApiError } from "../api/errors.js";
import type { OpClient } from "./op.js";

export type SecretsCheckResult = z.infer<typeof SecretsCheckResultSchema>;
export type SecretsView = z.infer<typeof SecretsViewSchema>;

export interface SecretsServiceOptions {
  op: OpClient;
  settings: () => GlobalSettings;
  /** The project's references; throws `not_found` for an unknown project. */
  projectRefs: (projectId: string) => Promise<SecretRef[]>;
  listProjects: () => Promise<{ projectId: string; refs: SecretRef[] }[]>;
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
  /** Values by reference, for the current launch only. */
  private cache = new Map<string, Promise<string>>();

  constructor(private readonly opts: SecretsServiceOptions) {}

  /** Starts a new launch: later reads go to `op` again. */
  beginLaunch(): void {
    this.cache = new Map();
  }

  clearCache(): void {
    this.cache = new Map();
  }

  /**
   * Resolves the global and the project's references into an environment
   * map. Throws `secrets_unavailable` when `op` is missing or a reference
   * doesn't resolve, and `secrets_locked` when `op` is not signed in.
   */
  async resolveEnv(projectId: string): Promise<Record<string, string>> {
    const refs = mergeSecretRefs(
      this.opts.settings().secretRefs,
      await this.opts.projectRefs(projectId),
    );
    if (refs.length === 0) return {};
    this.beginLaunch();
    try {
      await this.requireSignedIn();
      const env: Record<string, string> = {};
      for (const ref of refs) env[ref.name] = await this.read(ref.ref);
      return env;
    } finally {
      this.clearCache();
    }
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

  private read(ref: string): Promise<string> {
    let value = this.cache.get(ref);
    if (!value) {
      value = this.opts.op.read(ref);
      this.cache.set(ref, value);
    }
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
