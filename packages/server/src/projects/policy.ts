// The project's review policy file (`policy.yaml` by default), which the
// review app edits through `projects.policy.get` and `projects.policy.put`.
// The engine reads the same file with the same schema.
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_POLICY, PolicyFileSchema, type PolicyFile } from "@agentbox/contracts";
import { parse, stringify } from "yaml";
import { ApiError, messageOf } from "../records/errors.js";

export interface PolicyResult {
  /** Absolute host path of the policy file. */
  path: string;
  exists: boolean;
  policy: PolicyFile;
}

/**
 * Reads the policy file at `file`, or returns the default policy when it does
 * not exist. A file that is not valid YAML or does not match the schema fails
 * with `validation`.
 */
export function readPolicy(file: string): PolicyResult {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: file, exists: false, policy: DEFAULT_POLICY };
    }
    throw err;
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ApiError(
      "validation",
      `The policy file ${file} is not valid YAML: ${messageOf(err)}`,
    );
  }
  if (raw === null || raw === undefined)
    return { path: file, exists: true, policy: DEFAULT_POLICY };
  const parsed = PolicyFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("validation", `The policy file ${file} does not match the schema.`, {
      issues: parsed.error.issues,
    });
  }
  return { path: file, exists: true, policy: parsed.data };
}

/** Validates `policy` and writes it to `file` as YAML, creating the directory. */
export function writePolicy(file: string, policy: PolicyFile): PolicyResult {
  const parsed = PolicyFileSchema.safeParse(policy);
  if (!parsed.success) {
    throw new ApiError("validation", "The policy does not match the schema.", {
      issues: parsed.error.issues,
    });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, stringify(parsed.data));
  return { path: file, exists: true, policy: parsed.data };
}
