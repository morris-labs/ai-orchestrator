// The prompt for one agent that fills a role's seat for one task.
import type { RoleDefinition } from "@aio/contracts";
import { jsonInstruction } from "../../prompts/schema.js";
import type { SpecialtyPack } from "../specialties/load.js";

/** The placeholder in a write permission's path globs for the task's owned files. */
export const OWNED_FILES = "{owned}";

/** One task, as a role's agent sees it. */
export interface RoleTask {
  /** The task ID in the task graph, such as `T3`. */
  id: string;
  title: string;
  /** What the task builds. */
  description: string;
  /** The worktree that the agent works in. */
  repoPath: string;
  /** The task branch. */
  branch: string;
  /** The files that the task owns. */
  ownedFiles: readonly string[];
  /** The contract files that the task implements. */
  contracts?: readonly string[];
  /** The acceptance criteria that the task serves. */
  criteria: ReadonlyArray<{ id: string; text: string }>;
  /** The locked tests that must pass. */
  tests?: readonly string[];
  /** Extra context that the engine attaches, such as a diagnosis or gate output. */
  context?: string;
  /** The owner's decisions attached to the task, as `decisionsText()` writes them. */
  decisions?: string;
  /**
   * The packs of the task's specialties, from `loadSpecialties()`. Every
   * agent on the task gets their text, whatever its seat or vendor.
   */
  specialties?: ReadonlyArray<Pick<SpecialtyPack, "name" | "text">>;
}

/**
 * The repository-relative paths and globs that a role's agent can change for
 * `task`, with `{owned}` expanded to the task's owned files. A read-only role
 * gets none.
 */
export function writablePaths(role: RoleDefinition, task: RoleTask): string[] {
  if (role.permission.access === "read-only") return [];
  const paths = role.permission.paths.flatMap((glob) =>
    glob === OWNED_FILES ? [...task.ownedFiles] : [glob],
  );
  return [...new Set(paths)];
}

function section(title: string, body: string): string {
  return body.trim() === "" ? "" : `## ${title}\n\n${body.trim()}`;
}

function list(items: readonly string[] | undefined): string {
  return (items ?? []).map((item) => `- ${item}`).join("\n");
}

function permissionRule(role: RoleDefinition, task: RoleTask): string {
  if (role.permission.access === "read-only") {
    return "Don't change, create, or delete any file.";
  }
  return `Change only these files: ${writablePaths(role, task).join(", ")}.`;
}

/** The guidance of each specialty, each pack in its own tagged block. */
function specialtyGuidance(task: RoleTask): string {
  const packs = task.specialties ?? [];
  if (packs.length === 0) return "";
  return [
    "This task uses these specialties. Follow their guidance where it applies, and follow the rules above where the two differ.",
    ...packs.map((pack) => `<specialty name="${pack.name}">\n${pack.text.trim()}\n</specialty>`),
  ].join("\n\n");
}

/** The JSON schema of the role's answer, or `null` when no output has one. */
export function roleAnswerSchema(role: RoleDefinition): object | null {
  const structured = role.outputs.filter((output) => output.schema !== undefined);
  if (structured.length === 0) return null;
  if (structured.length === 1) return structured[0]?.schema ?? null;
  return {
    type: "object",
    additionalProperties: false,
    required: structured.map((output) => output.name),
    properties: Object.fromEntries(structured.map((output) => [output.name, output.schema])),
  };
}

/** Builds the prompt for an agent that fills `role`'s seat for `task`. */
export function rolePrompt(role: RoleDefinition, task: RoleTask): string {
  const schema = roleAnswerSchema(role);
  const outputs = role.outputs.map((output) => `${output.name}: ${output.description}`);
  return [
    `You are the ${role.title} on a build team. ${role.purpose.trim()}`,
    role.instructions,
    section("Rules", list([permissionRule(role, task), ...role.rules])),
    section("Specialties", specialtyGuidance(task)),
    section(
      `Task ${task.id}: ${task.title}`,
      `${task.description.trim()}\n\nRepository: ${task.repoPath}\nBranch: ${task.branch}`,
    ),
    section("Owned files", list(task.ownedFiles)),
    section("Contracts", list(task.contracts)),
    section(
      "Acceptance criteria",
      list(task.criteria.map((criterion) => `${criterion.id}: ${criterion.text}`)),
    ),
    section("Tests that must pass", list(task.tests)),
    section("Owner decisions", task.decisions ?? ""),
    section("Context", task.context ?? ""),
    section("Outputs", list(outputs)),
    schema ? jsonInstruction(schema) : "",
  ]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
}
