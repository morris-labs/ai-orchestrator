// The project's review policy file (`policy.yaml` by default), which the
// review app edits through `projects.policy.get` and `projects.policy.put`.
// The engine reads the same file with the same schema.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_POLICY,
  PolicyFileSchema,
  type PolicyFile,
  type PolicyPut,
} from "@agentbox/contracts";
import { parse, stringify } from "yaml";
import { ApiError, messageOf } from "../records/errors.js";

export interface PolicyResult {
  /** Absolute host path of the policy file. */
  path: string;
  exists: boolean;
  policy: PolicyFile;
  /** The file's text, or `null` when it doesn't exist. */
  text: string | null;
  /** Identifies the file's content; see `revisionOf`. */
  revision: string;
}

/** The revision of a file with `text`, or of a missing file when `text` is `null`. */
export function revisionOf(text: string | null): string {
  if (text === null) return "absent";
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Parses and validates policy text; an empty document is the default policy. */
function parsePolicyText(text: string, source: string): PolicyFile {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new ApiError("validation", `${source} is not valid YAML: ${messageOf(err)}`);
  }
  if (raw === null || raw === undefined) return DEFAULT_POLICY;
  const parsed = PolicyFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError("validation", `${source} does not match the schema.`, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

/**
 * Reads the policy file at `file`, or returns the default policy when it does
 * not exist. A file that is not valid YAML or does not match the schema fails
 * with `validation`.
 */
export function readPolicy(file: string): PolicyResult {
  const text = readText(file);
  if (text === null) {
    return { path: file, exists: false, policy: DEFAULT_POLICY, text, revision: revisionOf(text) };
  }
  return {
    path: file,
    exists: true,
    policy: parsePolicyText(text, `The policy file ${file}`),
    text,
    revision: revisionOf(text),
  };
}

/**
 * Validates `input` and writes it to `file`, creating the directory. Text is
 * written as it is, so its comments and key order survive; a policy object
 * is written as YAML. With `baseRevision`, a file whose content changed
 * since that revision fails with `conflict` and stays as it is.
 */
export function writePolicy(
  file: string,
  input: PolicyPut | PolicyFile,
  baseRevision?: string,
): PolicyResult {
  if (baseRevision !== undefined) {
    const current = revisionOf(readText(file));
    if (current !== baseRevision) {
      throw new ApiError(
        "conflict",
        `The policy file ${file} changed on disk since it was read.`,
        { revision: current },
      );
    }
  }
  let text: string;
  let policy: PolicyFile;
  if ("text" in input && typeof input.text === "string") {
    policy = parsePolicyText(input.text, "The policy");
    text = input.text;
  } else {
    const parsed = PolicyFileSchema.safeParse(input);
    if (!parsed.success) {
      throw new ApiError("validation", "The policy does not match the schema.", {
        issues: parsed.error.issues,
      });
    }
    policy = parsed.data;
    text = stringify(policy);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { path: file, exists: true, policy, text, revision: revisionOf(text) };
}
