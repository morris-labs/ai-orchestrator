// The `aio-build` command: starts, reads, pauses, and resumes a build from a
// box's session, over the engine's build socket. It sends the project ID
// and box ID that the server sets in the session's environment.
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import {
  BUILD_SOCKET_ENV,
  BUILDS_DIR,
  BuildSlugSchema,
  type BuildSocketRequestKind,
  type BuildState,
} from "@aio/contracts";
import { BuildSocketClient, BuildSocketError, buildSocketPath } from "./client.js";

export const BUILD_USAGE = `Usage:
  aio-build start SLUG PLAN_FILE [--base REF] [--json]
  aio-build status SLUG [--json]
  aio-build pause SLUG [--json]
  aio-build resume SLUG [--json]
  aio-build help

Drives a build of this box's project through the AI Orchestrator engine.
Every request prints the build's state afterward.

Requests:
  start     Start build SLUG from the build plan in PLAN_FILE, a JSON file
            ("-" reads standard input). The build works on the branch
            build/SLUG in its own worktree. --base REF names the branch,
            tag, or commit the build branch starts from; the default is
            HEAD.
  status    Print the state of build SLUG: its status, step, tasks, and
            escalations.
  pause     Pause build SLUG. The engine finishes the agent call in
            progress first.
  resume    Resume build SLUG after a pause.

SLUG uses lowercase letters, digits, and single hyphens, such as
cart-total.

Options:
  --json    Print the build's state as JSON instead of text.
  --help    Print this help.

Environment:
  ${BUILD_SOCKET_ENV.projectId}    The project ID. The server sets it in every box. Required.
  ${BUILD_SOCKET_ENV.boxId}        The box ID. The server sets it in every box session; the
                    build records it as the box that plans and watches it.
  ${BUILD_SOCKET_ENV.socket}  The engine's build socket. Default: /tmp/aio-build/build.sock.

Exit status: 0 on success, 2 for a usage error or a plan file that can't
be read, 3 when the build socket can't be reached, 4 for a build that this
project doesn't have, 5 when the engine refuses the request, such as a
plan that isn't valid or a slug in use, and 1 for any other failure.
`;

export interface BuildCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** Reads standard input, for a plan file named `-`. */
  stdin?: () => string;
  /** The socket client. Default: a `BuildSocketClient` for `env`. */
  client?: Pick<BuildSocketClient, "request">;
}

export type BuildCommand =
  | { kind: "help" }
  | { kind: "start"; slug: string; planFile: string; base: string | null; json: boolean }
  | { kind: Exclude<BuildSocketRequestKind, "start">; slug: string; json: boolean };

const KINDS = new Set(["start", "status", "pause", "resume"]);

/** Parses the arguments; throws an `Error` whose message explains a usage error. */
export function parseBuildArgs(argv: readonly string[]): BuildCommand {
  if (argv.length === 0) throw new Error("Name a request.");
  if (argv.some((a) => a === "--help" || a === "-h") || argv[0] === "help") {
    return { kind: "help" };
  }
  const [kind, ...rest] = argv as [string, ...string[]];
  if (!KINDS.has(kind)) throw new Error(`${kind} isn't a request.`);
  let json = false;
  let base: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--json") json = true;
    else if (a === "--base" || a.startsWith("--base=")) {
      if (kind !== "start") throw new Error("Only start takes --base.");
      const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : rest[++i];
      if (!value) throw new Error("--base needs a branch, tag, or commit.");
      base = value;
    } else if (a.startsWith("--") && a !== "--") throw new Error(`Unknown option: ${a}`);
    else positional.push(a);
  }
  const want = kind === "start" ? 2 : 1;
  if (positional.length !== want) {
    throw new Error(
      kind === "start" ? "start needs SLUG and PLAN_FILE." : `${kind} needs one SLUG.`,
    );
  }
  const slug = positional[0] as string;
  if (!BuildSlugSchema.safeParse(slug).success) {
    throw new Error(
      `${slug} isn't a valid slug: use lowercase letters, digits, and single hyphens.`,
    );
  }
  if (kind === "start") return { kind, slug, planFile: positional[1] as string, base, json };
  return { kind: kind as "status" | "pause" | "resume", slug, json };
}

/** The exit status for a failed request. */
function exitFor(code: BuildSocketError["code"]): number {
  if (code === "unreachable" || code === "protocol") return 3;
  if (code === "not_found") return 4;
  if (code === "internal") return 1;
  return 5;
}

/** One line for each schema issue in an error's details, when it has any. */
function issueLines(details: unknown): string {
  if (!Array.isArray(details)) return "";
  return details
    .map((issue: { path?: unknown; message?: unknown }) => {
      const where =
        Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "request";
      return `  ${where}: ${String(issue.message)}\n`;
    })
    .join("");
}

/** The build's state as text for a person to read. */
export function formatBuild(build: BuildState): string {
  const lines = [
    `Build ${build.slug}: ${build.status}, step ${build.step}`,
    `Title: ${build.title}`,
    `Branch: ${build.branch}`,
    `Worktree: ${build.worktree}`,
  ];
  if (build.boxId) lines.push(`Box: ${build.boxId}`);
  if (build.pausedUntil) lines.push(`Paused until: ${build.pausedUntil}`);
  if (build.note) lines.push(`Note: ${build.note}`);
  lines.push("Tasks:");
  for (const t of build.tasks) {
    const failure = t.lastFailure ? `, last failure: ${t.lastFailure}` : "";
    lines.push(`  ${t.id}  ${t.status}  attempts ${t.attempts}${failure}`);
  }
  if (build.escalations.length > 0) {
    lines.push("Escalations:");
    for (const e of build.escalations) {
      const task = e.taskId ? ` ${e.taskId}` : "";
      lines.push(`  ${e.id}  ${e.level}  ${e.kind}${task}: ${e.summary} (${e.file})`);
    }
  }
  lines.push(`Status file: ${posix.join(build.repoPath, BUILDS_DIR, build.slug, "STATUS.md")}`);
  return `${lines.join("\n")}\n`;
}

/** Runs `aio-build` and returns its exit status. */
export async function buildMain(argv: readonly string[], io: BuildCliIo): Promise<number> {
  let command: BuildCommand;
  try {
    command = parseBuildArgs(argv);
  } catch (err) {
    io.stderr(`aio-build: ${(err as Error).message}\n\n${BUILD_USAGE}`);
    return 2;
  }
  if (command.kind === "help") {
    io.stdout(BUILD_USAGE);
    return 0;
  }
  const projectId = io.env[BUILD_SOCKET_ENV.projectId];
  if (!projectId) {
    io.stderr(
      `aio-build: ${BUILD_SOCKET_ENV.projectId} isn't set. Run aio-build in a box session, which the server gives the project's ID.\n`,
    );
    return 2;
  }
  const boxId = io.env[BUILD_SOCKET_ENV.boxId] || null;
  let body: Record<string, unknown> = { projectId, boxId, slug: command.slug };
  if (command.kind === "start") {
    let plan: unknown;
    try {
      const text =
        command.planFile === "-"
          ? (io.stdin ?? (() => readFileSync(0, "utf8")))()
          : readFileSync(command.planFile, "utf8");
      plan = JSON.parse(text);
    } catch (err) {
      io.stderr(
        `aio-build: Can't read the plan file ${command.planFile}: ${(err as Error).message}\n`,
      );
      return 2;
    }
    body = { ...body, plan, ...(command.base !== null ? { base: command.base } : {}) };
  }
  try {
    const client = io.client ?? new BuildSocketClient(buildSocketPath(io.env));
    const build = await client.request(command.kind, body);
    io.stdout(command.json ? `${JSON.stringify(build, null, 2)}\n` : formatBuild(build));
    return 0;
  } catch (err) {
    if (err instanceof BuildSocketError) {
      io.stderr(`aio-build: ${err.message}\n${issueLines(err.details)}`);
      return exitFor(err.code);
    }
    io.stderr(`aio-build: ${(err as Error).message}\n`);
    return 1;
  }
}
