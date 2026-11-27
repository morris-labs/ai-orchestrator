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
  /** The tasks that this task builds on, whose work is on the branch. */
  dependsOn?: ReadonlyArray<{ id: string; title: string }>;
  /** True when the agent reaches the team chat's `send_message` tool. */
  teamChat?: boolean;
  /** Extra context that the engine attaches, such as a diagnosis or gate output. */
  context?: string;
  /**
   * The task's context pack, from `taskPack()`: the plan excerpt, the
   * criteria, and the contract and owned files' contents.
   */
  pack?: string;
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

/** How the agent uses the team chat, for an agent that reaches it. */
export const TEAM_CHAT_GUIDANCE = [
  "Your tools include send_message, the build team's chat. Use it when you need another seat, instead of guessing:",
  "",
  "- Ask a question with `type: question`, and answer one with `replyTo` set to its ID.",
  "- Ask the Architect about a shared contract with `type: contract_question`.",
  "- Ask the Developer that owns a file to change it with `type: file_request` and the file in `paths`.",
  "- Tell the Project manager something it must know with `type: note`, or send `to: owner` for the owner.",
  "",
  "The engine records you as the sender. Answers reach you in a later turn, so go on with the work you can do meanwhile. Dispute a locked test in your report's `dispute` field, never in a message.",
].join("\n");

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
    section("Depends on", list((task.dependsOn ?? []).map((t) => `${t.id}: ${t.title}`))),
    section("Context pack", task.pack ?? ""),
    section("Owner decisions", task.decisions ?? ""),
    section("Context", task.context ?? ""),
    section("Team chat", task.teamChat ? TEAM_CHAT_GUIDANCE : ""),
    section("Outputs", list(outputs)),
    schema ? jsonInstruction(schema) : "",
  ]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
}
