// Loads the repository policy, `<project>/.claude-box/policy.yaml` by default.
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  DEFAULT_POLICY,
  DEFAULT_POLICY_PATH,
  PolicyFileSchema,
  type PolicyFile,
} from "@agentbox/contracts";
import { parse } from "yaml";
import { ZodError, z } from "zod";

export class PolicyError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`The policy file ${path} is invalid: ${message}`);
    this.name = "PolicyError";
  }
}

/** The policy path for a project: `policyPath` relative to the root unless absolute. */
export function policyFilePath(projectRoot: string, policyPath = DEFAULT_POLICY_PATH): string {
  return isAbsolute(policyPath) ? policyPath : join(projectRoot, policyPath);
}

/**
 * Policy settings only the engine reads, kept beside the contract's fields
 * until `PolicyFileSchema` carries them. The contract schema is strict, so
 * these keys are taken out before it parses the file.
 */
export interface PolicyExtras {
  /**
   * GitHub logins whose pull request comments the post-push loop imports.
   * Absent means the repository's collaborators (see `postpush/loop.ts`).
   */
  commentAuthors: string[] | null;
}

const ExtrasSchema = z
  .object({ commentAuthors: z.array(z.string().min(1)).nullable().default(null) })
  .default({});

export const NO_EXTRAS: PolicyExtras = { commentAuthors: null };

function readYaml(text: string, path: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new PolicyError(path, (error as Error).message);
  }
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new PolicyError(path, "(root): Expected an object");
  }
  return raw as Record<string, unknown>;
}

/** Reads the engine-only settings from policy YAML text. Throws `PolicyError` on a bad value. */
export function parsePolicyExtras(text: string, path = "policy.yaml"): PolicyExtras {
  const raw = readYaml(text, path);
  const parsed = ExtrasSchema.safeParse({ commentAuthors: raw?.commentAuthors ?? null });
  if (!parsed.success) {
    throw new PolicyError(path, `commentAuthors: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  return parsed.data;
}

/** Parses policy YAML text, filling defaults. Throws `PolicyError` on bad YAML or schema. */
export function parsePolicy(text: string, path = "policy.yaml"): PolicyFile {
  const raw = readYaml(text, path);
  if (raw === null) return DEFAULT_POLICY;
  const { commentAuthors: _extra, ...contract } = raw;
  try {
    return PolicyFileSchema.parse(contract);
  } catch (error) {
    if (error instanceof ZodError) {
      const detail = error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new PolicyError(path, detail);
    }
    throw error;
  }
}

/** Loads the policy file, or returns `DEFAULT_POLICY` when it doesn't exist. */
export async function loadPolicy(projectRoot: string, policyPath?: string): Promise<PolicyFile> {
  const path = policyFilePath(projectRoot, policyPath);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_POLICY;
    throw error;
  }
  return parsePolicy(text, path);
}

/** Loads the engine-only policy settings, or `NO_EXTRAS` when the file doesn't exist. */
export async function loadPolicyExtras(
  projectRoot: string,
  policyPath?: string,
): Promise<PolicyExtras> {
  const path = policyFilePath(projectRoot, policyPath);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return NO_EXTRAS;
    throw error;
  }
  return parsePolicyExtras(text, path);
}
