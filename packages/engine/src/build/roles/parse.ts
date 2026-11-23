// Parses one role file: YAML front matter between `---` lines, then the
// Markdown body that holds the role's standing instructions.
import { RoleFrontMatterSchema, type RoleDefinition, type RoleSource } from "@aio/contracts";
import { parse } from "yaml";
import type { ZodIssue } from "zod";

/** A role file that can't be read or doesn't match the role definition format. */
export class RoleError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`The role file ${path} is invalid: ${message}`);
    this.name = "RoleError";
  }
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Describes one schema issue, naming the field it concerns. */
function describeIssue(issue: ZodIssue): string {
  const where = issue.path.join(".");
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => `${where ? `${where}.` : ""}${key}: unknown field`).join("; ");
  }
  if (issue.code === "invalid_type" && issue.received === "undefined") {
    return `${where}: missing field`;
  }
  return `${where || "(front matter)"}: ${issue.message}`;
}

/**
 * Parses the text of a role file. Throws `RoleError`, naming the field, when
 * the front matter is missing, isn't YAML, or has a missing or unknown field.
 */
export function parseRole(
  text: string,
  path: string,
  source: RoleSource = "repository",
): RoleDefinition {
  const match = FRONT_MATTER.exec(text);
  if (!match) {
    throw new RoleError(path, "the file must start with YAML front matter between --- lines");
  }
  let raw: unknown;
  try {
    raw = parse(match[1] ?? "");
  } catch (error) {
    throw new RoleError(path, `the front matter isn't valid YAML: ${(error as Error).message}`);
  }
  const result = RoleFrontMatterSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new RoleError(path, result.error.issues.map(describeIssue).join("; "));
  }
  return {
    ...result.data,
    instructions: text.slice(match[0].length).trim(),
    source,
    path,
  };
}
