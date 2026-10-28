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
import { ZodError } from "zod";

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

/** Parses policy YAML text, filling defaults. Throws `PolicyError` on bad YAML or schema. */
export function parsePolicy(text: string, path = "policy.yaml"): PolicyFile {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new PolicyError(path, (error as Error).message);
  }
  if (raw === null || raw === undefined) return DEFAULT_POLICY;
  try {
    return PolicyFileSchema.parse(raw);
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
