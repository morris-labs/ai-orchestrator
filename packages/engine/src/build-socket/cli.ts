// The `aio-build` command: plans, meets, starts, reads, pauses, resumes, and
// cancels a build from a box's session, over the engine's build socket. It sends the project
// ID and box ID that the server sets in the session's environment.
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import {
  BUILD_SOCKET_ENV,
  BUILDS_DIR,
  BuildSlugSchema,
  MEETING_ROUND_MAX,
  MeetingIdSchema,
  RoleNameSchema,
  type BuildDecision,
  type BuildFreezeAnswer,
  type BuildMeetingAnswer,
  type BuildIssueInput,
  type BuildSeatAnswer,
  type BuildSocketRequestKind,
  type BuildState,
  type Message,
} from "@aio/contracts";
import { BuildSocketClient, BuildSocketError, buildSocketPath } from "./client.js";

/** How long a planning seat call can take before the command stops waiting. */
export const PLANNING_TIMEOUT_MS = 3 * 60 * 60_000;

/** How long a meeting can take before the command stops waiting: several seat calls. */
export const MEETING_TIMEOUT_MS = 8 * 60 * 60_000;

export const BUILD_USAGE = `Usage:
  aio-build plan SLUG SEAT BRIEF_FILE [--issue ISSUE] [--json]
  aio-build meet SLUG BRIEF_FILE [--members SEAT,...] [--proposer SEAT] [--rounds N] [--json]
  aio-build meeting-post SLUG MEETING POST_FILE [--json]
  aio-build freeze SLUG [PLAN_FILE] [--push yes|no] [--json]
  aio-build start SLUG [PLAN_FILE] [--base REF] [--json]
  aio-build status SLUG [--json]
  aio-build pause SLUG [--json]
  aio-build resume SLUG [--json]
  aio-build messages SLUG [--direct] [--json]
  aio-build decisions SLUG [--json]
  aio-build cancel SLUG [--json]
  aio-build help

Plans and drives a build of this box's project through the AI Orchestrator
engine.

Requests:
  plan      Call the planning seat SEAT, such as analyst or architect, for
            build SLUG with the brief in BRIEF_FILE ("-" reads standard
            input), and print its answer. The first planning request
            starts the build's planning record. The request waits until the
            seat answers, which can take many minutes. Once the Analyst and
            the Architect have answered, the engine drafts the build plan in
            .aio/builds/SLUG/planning/draft.json.
  meet      Open a meeting of build SLUG on the proposer's latest answer,
            with the brief in BRIEF_FILE ("-" reads standard input), and
            print its outcome. Each member replies once per round with a
            position and a severity for each point; the proposer revises
            while a major objection remains, until the round cap. The
            request waits until the meeting ends, which can take hours.
            The record is in .aio/builds/SLUG/meetings/.
  meeting-post
            Relay the owner's post in POST_FILE to meeting MEETING of build
            SLUG, such as meeting-1, while it runs. Every member reads it
            at its next turn.
  freeze    Freeze the build plan in PLAN_FILE, a JSON file ("-" reads
            standard input), or without PLAN_FILE the draft plan. A plan
            that changed since the last freeze becomes the next version in
            .aio/builds/SLUG/plans/; a frozen version never changes. The
            freeze needs the owner's answer to whether the build can push
            its branch and open its pull request: ask the owner, then pass
            --push yes or --push no.
  start     Start build SLUG from its latest frozen plan, or from the plan
            in PLAN_FILE when it has none. The build works on the branch
            build/SLUG in its own worktree. --base REF names the branch,
            tag, or commit the build branch starts from; the default is
            HEAD.
  status    Print the state of build SLUG: its status, step, tasks, and
            escalations.
  pause     Pause build SLUG. The engine finishes the agent call in
            progress first.
  resume    Resume build SLUG after a pause or a cancel.
  cancel    Cancel build SLUG. The engine stops every agent and the
            build's review run, and keeps the branch and the worktree.
            The Scribe then writes a closing record in the build
            directory. The build stays resumable until the owner deletes
            it.
  messages  Print the team chat messages of build SLUG, oldest first. With
            --direct, print only the direct messages: the ones that agents
            sent the owner.
  decisions Print the owner's decisions of build SLUG: one for each owner
            post, with the task it's attached to. A decision flagged as a
            plan change contradicts acceptance criteria of the build plan:
            change the plan's criteria to match it, or ask the owner.

A build that a box started takes pause, resume, and cancel requests only
from that box. Any box of the project can read its status.

SLUG uses lowercase letters, digits, and single hyphens, such as
cart-total.

Options:
  --issue ISSUE  The GitHub issue the build starts from, as OWNER/NAME#NUMBER
                 or as the issue's link. The build plan links back to it.
  --members SEAT,...
                 The seats that reply in a meeting. Default: critic. The
                 Critic runs on a vendor other than the proposer's.
  --proposer SEAT
                 The seat whose proposal a meeting discusses. Default:
                 architect.
  --rounds N     A meeting's round cap, from 1 to ${MEETING_ROUND_MAX}. Default: 3.
  --push yes|no  The owner's answer to whether the build can push its branch
                 and open its pull request.
  --direct       Print only the direct messages to the owner.
  --json         Print the answer as JSON instead of text.
  --help         Print this help.

Environment:
  ${BUILD_SOCKET_ENV.projectId}    The project ID. The server sets it in every box. Required.
  ${BUILD_SOCKET_ENV.boxId}        The box ID. The server sets it in every box session; the
                    build records it as the box that plans and watches it.
  ${BUILD_SOCKET_ENV.socket}  The engine's build socket. Default: /tmp/aio-build/build.sock.

Exit status: 0 on success, 2 for a usage error or a brief or plan file that
can't be read, 3 when the build socket can't be reached, 4 for a build that
this project doesn't have, 5 when the engine refuses the request, such as a
plan that isn't valid, a freeze without the push answer, or a slug in use,
and 1 for any other failure, such as a seat call that failed.
`;

export interface BuildCliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** Reads standard input, for a brief or plan file named `-`. */
  stdin?: () => string;
  /** The socket client. Default: a `BuildSocketClient` for `env`. */
  client?: Pick<BuildSocketClient, "send">;
}

export type BuildCommand =
  | { kind: "help" }
  | {
      kind: "plan";
      slug: string;
      seat: string;
      briefFile: string;
      issue: BuildIssueInput | null;
      json: boolean;
    }
  | {
      kind: "meet";
      slug: string;
      briefFile: string;
      members: string[] | null;
      proposer: string | null;
      rounds: number | null;
      json: boolean;
    }
  | { kind: "meeting-post"; slug: string; meeting: string; postFile: string; json: boolean }
  | { kind: "freeze"; slug: string; planFile: string | null; push: boolean | null; json: boolean }
  | { kind: "start"; slug: string; planFile: string | null; base: string | null; json: boolean }
  | { kind: "messages"; slug: string; direct: boolean; json: boolean }
  | { kind: "decisions"; slug: string; json: boolean }
  | {
      kind: Exclude<
        BuildSocketRequestKind,
        "start" | "plan" | "freeze" | "meet" | "meeting-post" | "messages" | "decisions"
      >;
      slug: string;
      json: boolean;
    };

const KINDS = new Set([
  "plan",
  "meet",
  "meeting-post",
  "freeze",
  "start",
  "status",
  "pause",
  "resume",
  "messages",
  "decisions",
  "cancel",
]);

/** The options each request takes, beyond `--json`. */
const OPTIONS: Record<string, readonly string[]> = {
  plan: ["--issue"],
  meet: ["--members", "--proposer", "--rounds"],
  freeze: ["--push"],
  start: ["--base"],
};

/** Parses `OWNER/NAME#NUMBER` or an issue link such as `https://HOST/OWNER/NAME/issues/NUMBER`. */
export function parseIssue(text: string): BuildIssueInput {
  const short = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(text);
  if (short) return { repository: short[1] as string, number: Number(short[2]) };
  const link = /^https?:\/\/[^/\s]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)\/?$/.exec(
    text,
  );
  if (link) return { repository: link[1] as string, number: Number(link[2]), url: text };
  throw new Error(`${text} isn't an issue: use OWNER/NAME#NUMBER or the issue's link.`);
}

/** Parses the arguments; throws an `Error` whose message explains a usage error. */
export function parseBuildArgs(argv: readonly string[]): BuildCommand {
  if (argv.length === 0) throw new Error("Name a request.");
  if (argv.some((a) => a === "--help" || a === "-h") || argv[0] === "help") {
    return { kind: "help" };
  }
  const [kind, ...rest] = argv as [string, ...string[]];
  if (!KINDS.has(kind)) throw new Error(`${kind} isn't a request.`);
  let json = false;
  let direct = false;
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--direct") {
      if (kind !== "messages") throw new Error(`${kind} doesn't take --direct.`);
      direct = true;
      continue;
    }
    const option = ["--base", "--issue", "--push", "--members", "--proposer", "--rounds"].find(
      (o) => a === o || a.startsWith(`${o}=`),
    );
    if (option) {
      if (!(OPTIONS[kind] ?? []).includes(option)) {
        throw new Error(`${kind} doesn't take ${option}.`);
      }
      const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : rest[++i];
      if (!value) throw new Error(`${option} needs a value.`);
      values.set(option, value);
    } else if (a.startsWith("--") && a !== "--") throw new Error(`Unknown option: ${a}`);
    else positional.push(a);
  }
  const [slug] = positional;
  if (slug === undefined) throw new Error(`${kind} needs a SLUG.`);
  if (!BuildSlugSchema.safeParse(slug).success) {
    throw new Error(
      `${slug} isn't a valid slug: use lowercase letters, digits, and single hyphens.`,
    );
  }
  if (kind === "plan") {
    if (positional.length !== 3) throw new Error("plan needs SLUG, SEAT, and BRIEF_FILE.");
    const seat = positional[1] as string;
    if (!RoleNameSchema.safeParse(seat).success) {
      throw new Error(`${seat} isn't a seat: name a role such as analyst or architect.`);
    }
    const issue = values.get("--issue");
    return {
      kind,
      slug,
      seat,
      briefFile: positional[2] as string,
      issue: issue === undefined ? null : parseIssue(issue),
      json,
    };
  }
  if (kind === "meet") {
    if (positional.length !== 2) throw new Error("meet needs SLUG and BRIEF_FILE.");
    const seatName = (seat: string): string => {
      if (!RoleNameSchema.safeParse(seat).success) throw new Error(`${seat} isn't a seat.`);
      return seat;
    };
    const members = values.get("--members");
    const proposer = values.get("--proposer");
    const rounds = values.get("--rounds");
    if (rounds !== undefined && !/^[1-9][0-9]*$/.test(rounds)) {
      throw new Error(`--rounds takes a number from 1 to ${MEETING_ROUND_MAX}.`);
    }
    if (rounds !== undefined && Number(rounds) > MEETING_ROUND_MAX) {
      throw new Error(`--rounds takes a number from 1 to ${MEETING_ROUND_MAX}.`);
    }
    return {
      kind,
      slug,
      briefFile: positional[1] as string,
      members: members === undefined ? null : members.split(",").map((m) => seatName(m.trim())),
      proposer: proposer === undefined ? null : seatName(proposer),
      rounds: rounds === undefined ? null : Number(rounds),
      json,
    };
  }
  if (kind === "meeting-post") {
    if (positional.length !== 3) {
      throw new Error("meeting-post needs SLUG, MEETING, and POST_FILE.");
    }
    const meeting = positional[1] as string;
    if (!MeetingIdSchema.safeParse(meeting).success) {
      throw new Error(`${meeting} isn't a meeting: name one such as meeting-1.`);
    }
    return { kind, slug, meeting, postFile: positional[2] as string, json };
  }
  if (kind === "freeze" || kind === "start") {
    if (positional.length > 2) throw new Error(`${kind} takes SLUG and at most one PLAN_FILE.`);
    const planFile = positional[1] ?? null;
    if (kind === "start") return { kind, slug, planFile, base: values.get("--base") ?? null, json };
    const answer = values.get("--push");
    if (answer !== undefined && answer !== "yes" && answer !== "no") {
      throw new Error("--push takes yes or no.");
    }
    return { kind, slug, planFile, push: answer === undefined ? null : answer === "yes", json };
  }
  if (positional.length !== 1) throw new Error(`${kind} needs one SLUG.`);
  if (kind === "messages") return { kind, slug, direct, json };
  if (kind === "decisions") return { kind, slug, json };
  return { kind: kind as "status" | "pause" | "resume" | "cancel", slug, json };
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
  if (build.pausedBy)
    lines.push(`Paused by: ${build.pausedBy === "box" ? "a box stop" : "a request"}`);
  if (build.pausedUntil) lines.push(`Paused until: ${build.pausedUntil}`);
  if (build.deletedAt) lines.push(`Deleted: ${build.deletedAt}`);
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
  const dir = posix.join(build.repoPath, BUILDS_DIR, build.slug);
  lines.push(`Status file: ${posix.join(dir, "STATUS.md")}`);
  if (build.closingRecord) lines.push(`Closing record: ${posix.join(dir, build.closingRecord)}`);
  return `${lines.join("\n")}\n`;
}

/** A team chat party as text: `owner`, or the seat with its task. */
function partyText(party: Message["from"]): string {
  if (party.kind === "owner") return "owner";
  return party.taskId ? `${party.seat} (${party.taskId})` : party.seat;
}

/** Text indented under a header line. */
const indent = (text: string): string =>
  text
    .trimEnd()
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

/** Team chat messages as text for a person to read. */
export function formatMessages(
  slug: string,
  messages: readonly Message[],
  direct: boolean,
): string {
  if (messages.length === 0) {
    return `Build ${slug} has no ${direct ? "direct messages" : "team chat messages"}.\n`;
  }
  return messages
    .map((m) => {
      const about = [m.taskId, m.milestone].filter((x) => x !== null).join(", ");
      return `${m.id}  ${partyText(m.from)} -> ${partyText(m.to)}  ${m.type}  ${about}  ${m.createdAt}\n${indent(m.body)}\n`;
    })
    .join("\n");
}

/** Decisions as text for a person to read. */
export function formatDecisions(slug: string, decisions: readonly BuildDecision[]): string {
  if (decisions.length === 0) return `Build ${slug} has no decisions.\n`;
  return decisions
    .map((d) => {
      const lines = [
        `${d.id}  owner post ${d.messageId} to ${partyText(d.to)}  ${[d.taskId, d.milestone].filter((x) => x !== null).join(", ")}  ${d.createdAt}`,
        indent(d.body),
      ];
      if (d.planChange) {
        lines.push(
          `  Plan change: contradicts ${d.planChange.criteria.join(", ")}, reported by ${partyText(d.planChange.reportedBy)}.`,
          indent(d.planChange.reason),
        );
      }
      return `${lines.join("\n")}\n`;
    })
    .join("\n");
}

/** A file in the build's directory, as the container sees it. */
function buildFile(repoPath: string, slug: string, file: string): string {
  return posix.join(repoPath, BUILDS_DIR, slug, file);
}

/** A seat's answer as text for a person to read. */
export function formatSeatAnswer(answer: BuildSeatAnswer): string {
  const { planning, call } = answer;
  return [
    `The ${call.seat} answered build ${planning.slug} (call ${call.n}).`,
    `Answer file: ${buildFile(planning.repoPath, planning.slug, call.file)}`,
    `Draft plan, once the spec and the design exist: ${buildFile(planning.repoPath, planning.slug, "planning/draft.json")}`,
    JSON.stringify(answer.answer, null, 2),
    "",
  ].join("\n");
}

/** A freeze's answer as text for a person to read. */
export function formatFreeze(answer: BuildFreezeAnswer): string {
  const { planning, frozen } = answer;
  return [
    `Froze build ${planning.slug}'s plan as version ${frozen.version}: ${buildFile(planning.repoPath, planning.slug, frozen.file)}`,
    `Push: ${frozen.push ? "allowed" : "not allowed"}`,
    ...(answer.plan.issue ? [`Issue: ${answer.plan.issue.url}`] : []),
    `Start the build with: aio-build start ${planning.slug}`,
    "",
  ].join("\n");
}

/** A meeting's outcome as text for a person to read. */
export function formatMeeting(answer: BuildMeetingAnswer): string {
  const { planning, meeting } = answer;
  const lines = [
    `Meeting ${meeting.id} of build ${planning.slug}: ${meeting.status} after ${meeting.rounds.length} of ${meeting.roundCap} rounds.`,
    `Record: ${buildFile(planning.repoPath, planning.slug, `meetings/${meeting.id}.json`)}`,
    `Proposal: ${buildFile(planning.repoPath, planning.slug, meeting.rounds.at(-1)?.proposal ?? "planning/")}`,
  ];
  if (meeting.error) lines.push(`Error: ${meeting.error}`);
  if (meeting.open.length > 0) {
    lines.push("Open objections:");
    for (const o of meeting.open) lines.push(`  ${o.seat}: ${o.point} (${o.reason})`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Reads a brief or plan file, or standard input for `-`. */
function readInput(io: BuildCliIo, file: string): string {
  return file === "-"
    ? (io.stdin ?? (() => readFileSync(0, "utf8")))()
    : readFileSync(file, "utf8");
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
  const file =
    command.kind === "plan" || command.kind === "meet"
      ? command.briefFile
      : command.kind === "meeting-post"
        ? command.postFile
        : command.kind === "start" || command.kind === "freeze"
          ? command.planFile
          : null;
  let input: string | null = null;
  if (file !== null) {
    try {
      input = readInput(io, file);
    } catch (err) {
      const what =
        command.kind === "plan" || command.kind === "meet"
          ? "brief"
          : command.kind === "meeting-post"
            ? "post"
            : "plan";
      io.stderr(`aio-build: Can't read the ${what} file ${file}: ${(err as Error).message}\n`);
      return 2;
    }
  }
  if ((command.kind === "start" || command.kind === "freeze") && input !== null) {
    try {
      body.plan = JSON.parse(input) as unknown;
    } catch (err) {
      io.stderr(`aio-build: Can't read the plan file ${file}: ${(err as Error).message}\n`);
      return 2;
    }
  }
  if (command.kind === "plan") {
    body = {
      ...body,
      seat: command.seat,
      brief: input,
      ...(command.issue ? { issue: command.issue } : {}),
    };
  } else if (command.kind === "meet") {
    body = {
      ...body,
      brief: input,
      ...(command.members ? { members: command.members } : {}),
      ...(command.proposer ? { proposer: command.proposer } : {}),
      ...(command.rounds !== null ? { rounds: command.rounds } : {}),
    };
  } else if (command.kind === "meeting-post") {
    body = { ...body, meeting: command.meeting, body: input };
  } else if (command.kind === "freeze" && command.push !== null) {
    body.push = command.push;
  } else if (command.kind === "start" && command.base !== null) {
    body.base = command.base;
  } else if (command.kind === "messages") {
    body.direct = command.direct;
  }
  try {
    const client =
      io.client ??
      new BuildSocketClient(
        buildSocketPath(io.env),
        command.kind === "plan"
          ? PLANNING_TIMEOUT_MS
          : command.kind === "meet"
            ? MEETING_TIMEOUT_MS
            : undefined,
      );
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    if (command.kind === "plan") {
      const answer = await client.send("plan", body);
      io.stdout(command.json ? json(answer) : formatSeatAnswer(answer));
    } else if (command.kind === "meet" || command.kind === "meeting-post") {
      const answer = await client.send(command.kind, body);
      io.stdout(command.json ? json(answer) : formatMeeting(answer));
    } else if (command.kind === "freeze") {
      const answer = await client.send("freeze", body);
      io.stdout(command.json ? json(answer) : formatFreeze(answer));
    } else if (command.kind === "messages") {
      const { messages } = await client.send("messages", body);
      io.stdout(
        command.json ? json(messages) : formatMessages(command.slug, messages, command.direct),
      );
    } else if (command.kind === "decisions") {
      const { decisions } = await client.send("decisions", body);
      io.stdout(command.json ? json(decisions) : formatDecisions(command.slug, decisions));
    } else {
      const { build } = await client.send(command.kind, body);
      io.stdout(command.json ? json(build) : formatBuild(build));
    }
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
