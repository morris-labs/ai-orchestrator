// The `aio-build` command: plans, meets, starts, reads, pauses, resumes, and
// cancels a build, and resolves its escalations, from a box's session, over
// the engine's build socket. It sends the project
// ID and box ID that the server sets in the session's environment.
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import {
  BUILD_SOCKET_ENV,
  BUILD_SOCKET_SESSION_HEADERS,
  BUILDS_DIR,
  BuildSlugSchema,
  EscalationActionSchema,
  MEETING_ROUND_MAX,
  MeetingIdSchema,
  RoleNameSchema,
  engineDefectNote,
  escalationState,
  type BuildDecision,
  type BuildFreezeAnswer,
  type BuildMeetingAnswer,
  type BuildIssueInput,
  type BuildPlanning,
  type BuildSeatAnswer,
  type BuildSocketRequestKind,
  type BuildState,
  type Message,
  type PmInbox,
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
  aio-build meeting-end SLUG MEETING [--json]
  aio-build freeze SLUG [PLAN_FILE] [--push yes|no] [--json]
  aio-build start SLUG [PLAN_FILE] [--base REF] [--json]
  aio-build status SLUG [--json]
  aio-build pause SLUG [--json]
  aio-build resume SLUG [--json]
  aio-build messages SLUG [--direct] [--json]
  aio-build decisions SLUG [--json]
  aio-build inbox SLUG [--all] [--json]
  aio-build cancel SLUG [--json]
  aio-build resolve SLUG ESCALATION ACTION [--note TEXT] [--order TASKS]
                    [--decision OPTION] [--waive FINDINGS] [--push yes|no]
                    [--changes PARTS] [--own FILES] [--engine-defect]
                    [--owner] [--json]
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
  meeting-end
            End meeting MEETING of build SLUG early, such as once you froze
            the plan it discusses. The engine stops the turn under way, and
            the meeting ends as ended, with the major objections of its
            last full round open. Planning then takes requests again.
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
            escalations. For a build in planning, print its planning
            record: the seat calls, the meetings, and the frozen plan.
  pause     Pause build SLUG. The engine finishes the agent call or
            gate in progress first; once nothing runs, status shows the
            build as paused (idle), and the worktree holds still.
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
  inbox     Print the Project manager inbox of build SLUG: each escalation
            and digest whose pointer the engine didn't deliver to this
            session yet, and each escalation that waits for its answer,
            oldest first. With --all, print every item. Read the file that
            each item names.
  resolve   Resolve escalation ESCALATION, such as E1, of build SLUG, and
            resume the tasks it paused. ACTION is one of:
              retry     Run the paused work again. A task gets more attempts.
              reorder   Set the order of the tasks that aren't done with
                        --order, then retry.
              clarify   Add the clarification in --note, which the build
                        plan already implies, to the task, then retry.
              decide    Answer the decision that the build's review run
                        waits for with --decision, then retry.
              escalate  Hand the escalation to the owner, with the reason
                        in --note.
            A decision that changes the criteria, the scope, or the
            milestones is the owner's: name the changes with --changes, and
            the engine marks the escalation for the owner instead of
            resolving it. With retry or clarify, --own gives the
            escalation's task more files to change, such as a file that
            the build plan left out of every task. An escalation for the owner, such as a missing
            secret, takes only the owner's decision: ask the owner, then
            pass --owner. For a release ready escalation, ask the owner
            whether the build can push its branch and open its pull
            request, then pass --push yes or --push no with --owner.
            When an engine defect raised the escalation, pass
            --engine-defect with the defect in --note: the engine writes
            an engine defect note in the build directory and pauses the
            build. Don't fix the engine in this session. A separate session
            fixes it, and the owner resumes the build.

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
  --note TEXT    Why, or the clarification itself for clarify.
  --order TASKS  The task IDs in the order they run, separated by commas,
                 such as T2,T1.
  --decision OPTION
                 The answer to the review run's decision: resume,
                 resume_waive, or cancel.
  --waive FINDINGS
                 With resume_waive: the finding IDs to waive, separated by
                 commas.
  --changes PARTS
                 The parts of the build plan that the decision changes,
                 separated by commas: criteria, scope, milestones,
                 contracts, or architecture.
  --own FILES    With retry or clarify: files or globs, separated by commas,
                 that the escalation's task may change from now on. The
                 engine adds them to the task's owned files in the build
                 plan. A test path, and a file that another unfinished task
                 owns, stay out.
  --engine-defect
                 Name an engine defect as the escalation's cause. Needs
                 --note, which describes the defect, and an action other
                 than escalate. The build pauses until the owner resumes it.
  --owner        Record the decision as the owner's, which the Project
                 manager relays.
  --direct       Print only the direct messages to the owner.
  --all          Print every inbox item, including delivered digests and
                 answered escalations.
  --json         Print the answer as JSON instead of text.
  --help         Print this help.

Environment:
  ${BUILD_SOCKET_ENV.projectId}    The project ID. The server sets it in every box. Required.
  ${BUILD_SOCKET_ENV.boxId}        The box ID. The server sets it in every box session; the
                    build records it as the box that plans and watches it.
  ${BUILD_SOCKET_ENV.socket}  The engine's build socket. Default: /tmp/aio-build/build.sock.
  CLAUDE_CODE_SESSION_ID, CLAUDE_CONFIG_DIR
                    Claude Code sets them in its shells. The command names the
                    session, so the engine counts the Project manager's usage
                    from the session's transcript.

Exit status: 0 on success, 2 for a usage error or a brief or plan file that
can't be read, 3 when the build socket can't be reached, 4 for a build or an
escalation that this project doesn't have, 5 when the engine refuses the
request, such as a plan that isn't valid, a freeze without the push answer, a
slug in use, or a resolution that doesn't fit the escalation, and 1 for any
other failure, such as a seat call that failed.
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
  | { kind: "meeting-end"; slug: string; meeting: string; json: boolean }
  | { kind: "freeze"; slug: string; planFile: string | null; push: boolean | null; json: boolean }
  | { kind: "start"; slug: string; planFile: string | null; base: string | null; json: boolean }
  | { kind: "messages"; slug: string; direct: boolean; json: boolean }
  | { kind: "decisions"; slug: string; json: boolean }
  | { kind: "inbox"; slug: string; all: boolean; json: boolean }
  | {
      kind: "resolve";
      slug: string;
      /** The resolve request's fields beyond the project, box, and slug. */
      resolution: Record<string, unknown>;
      json: boolean;
    }
  | {
      kind: Exclude<
        BuildSocketRequestKind,
        | "start"
        | "plan"
        | "freeze"
        | "meet"
        | "meeting-post"
        | "meeting-end"
        | "messages"
        | "decisions"
        | "inbox"
        | "resolve"
      >;
      slug: string;
      json: boolean;
    };

const KINDS = new Set([
  "plan",
  "meet",
  "meeting-post",
  "meeting-end",
  "freeze",
  "start",
  "status",
  "pause",
  "resume",
  "messages",
  "decisions",
  "inbox",
  "cancel",
  "resolve",
]);

/** The options each request takes, beyond `--json`. */
const OPTIONS: Record<string, readonly string[]> = {
  plan: ["--issue"],
  meet: ["--members", "--proposer", "--rounds"],
  freeze: ["--push"],
  start: ["--base"],
  resolve: [
    "--note",
    "--order",
    "--decision",
    "--waive",
    "--push",
    "--changes",
    "--own",
    "--engine-defect",
    "--owner",
  ],
  inbox: ["--all"],
};

/** Every option that takes a value. */
const VALUE_OPTIONS = [
  "--base",
  "--issue",
  "--push",
  "--members",
  "--proposer",
  "--rounds",
  "--note",
  "--order",
  "--decision",
  "--waive",
  "--changes",
  "--own",
];

/** Options that take no value. */
const FLAGS = ["--owner", "--all", "--engine-defect"];

/** Splits a comma-separated list, dropping empty items. */
function list(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Parses a `--push` answer. */
function pushAnswer(answer: string): boolean {
  if (answer !== "yes" && answer !== "no") throw new Error("--push takes yes or no.");
  return answer === "yes";
}

/**
 * The fields of a resolve request from its positional arguments and options.
 * The engine checks the rest, such as whether the action fits the escalation.
 */
function resolution(
  positional: readonly string[],
  values: ReadonlyMap<string, string>,
  flags: ReadonlySet<string>,
): Record<string, unknown> {
  if (positional.length !== 3) throw new Error("resolve needs SLUG, ESCALATION, and ACTION.");
  const [, escalation, action] = positional as [string, string, string];
  if (!EscalationActionSchema.safeParse(action).success) {
    throw new Error(
      `${action} isn't a resolution: use ${EscalationActionSchema.options.join(", ")}.`,
    );
  }
  const note = values.get("--note");
  const order = values.get("--order");
  const option = values.get("--decision");
  const waive = values.get("--waive");
  const push = values.get("--push");
  const changes = values.get("--changes");
  const own = values.get("--own");
  if (waive !== undefined && option === undefined) throw new Error("--waive needs --decision.");
  return {
    escalation,
    action,
    ...(flags.has("--owner") ? { by: "owner" } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(order !== undefined ? { order: list(order) } : {}),
    ...(option !== undefined
      ? { decision: { option, ...(waive !== undefined ? { waiveFindingIds: list(waive) } : {}) } }
      : {}),
    ...(push !== undefined ? { push: pushAnswer(push) } : {}),
    ...(changes !== undefined ? { changes: list(changes) } : {}),
    ...(own !== undefined ? { own: list(own) } : {}),
    ...(flags.has("--engine-defect") ? { cause: "engine_defect" } : {}),
  };
}

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
  const flags = new Set<string>();
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
    const flag = FLAGS.find((f) => a === f);
    if (flag) {
      if (!(OPTIONS[kind] ?? []).includes(flag)) throw new Error(`${kind} doesn't take ${flag}.`);
      flags.add(flag);
      continue;
    }
    const option = VALUE_OPTIONS.find((o) => a === o || a.startsWith(`${o}=`));
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
  if (kind === "meeting-end") {
    if (positional.length !== 2) throw new Error("meeting-end needs SLUG and MEETING.");
    const meeting = positional[1] as string;
    if (!MeetingIdSchema.safeParse(meeting).success) {
      throw new Error(`${meeting} isn't a meeting: name one such as meeting-1.`);
    }
    return { kind, slug, meeting, json };
  }
  if (kind === "freeze" || kind === "start") {
    if (positional.length > 2) throw new Error(`${kind} takes SLUG and at most one PLAN_FILE.`);
    const planFile = positional[1] ?? null;
    if (kind === "start") return { kind, slug, planFile, base: values.get("--base") ?? null, json };
    const answer = values.get("--push");
    return { kind, slug, planFile, push: answer === undefined ? null : pushAnswer(answer), json };
  }
  if (kind === "resolve") {
    return { kind, slug, resolution: resolution(positional, values, flags), json };
  }
  if (positional.length !== 1) throw new Error(`${kind} needs one SLUG.`);
  if (kind === "messages") return { kind, slug, direct, json };
  if (kind === "decisions") return { kind, slug, json };
  if (kind === "inbox") return { kind, slug, all: flags.has("--all"), json };
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

/** Who paused the build, in a few words, with the engine defect note for an engine defect. */
function pausedByText(build: BuildState): string {
  if (build.pausedBy === "box") return "a box stop";
  if (build.pausedBy !== "engine_defect") return "a request";
  const note = engineDefectNote(build);
  return `an engine defect${note ? `, see ${note}` : ""}; the owner resumes the build once a separate session fixes the engine`;
}

/** The build's state as text for a person to read. */
export function formatBuild(build: BuildState): string {
  const lines = [
    `Build ${build.slug}: ${build.status}${build.idle ? " (idle)" : ""}, step ${build.step}`,
    `Title: ${build.title}`,
    `Branch: ${build.branch}`,
    `Worktree: ${build.worktree}`,
  ];
  if (build.boxId) lines.push(`Box: ${build.boxId}`);
  if (build.pausedBy) lines.push(`Paused by: ${pausedByText(build)}`);
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
      lines.push(
        `  ${e.id}  ${escalationState(e)}  ${e.level}  ${e.kind}${task}: ${e.summary} (${e.file})`,
      );
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

/** Where an inbox item stands, in a few words. */
function itemState(item: PmInbox["items"][number]): string {
  const delivery = item.deliveredAt === null ? "not delivered" : "delivered";
  if (!item.needsAnswer) return delivery;
  return `${delivery}, ${item.answeredAt === null ? "waits for an answer" : "answered"}`;
}

/** Inbox items as text for a person to read. */
export function formatInbox(inbox: PmInbox, all: boolean): string {
  if (inbox.items.length === 0) {
    return `Build ${inbox.slug} has ${all ? "no inbox items" : "nothing waiting in its inbox"}.\n`;
  }
  return inbox.items
    .map(
      (i) =>
        `${i.id}  ${i.kind} ${i.ref}  ${itemState(i)}  ${i.createdAt}\n${indent(i.summary)}\n  Read ${i.path}\n`,
    )
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

/** The planning record of a build in planning as text for a person to read. */
export function formatPlanning(planning: BuildPlanning): string {
  const lines = [`Build ${planning.slug}: planning`];
  if (planning.pausedBy) lines.push("Paused by: a box stop");
  if (planning.boxId) lines.push(`Box: ${planning.boxId}`);
  if (planning.issue) lines.push(`Issue: ${planning.issue.url}`);
  lines.push("Seat calls:");
  if (planning.calls.length === 0) lines.push("  none");
  for (const c of planning.calls) {
    lines.push(
      `  ${c.seat} ${c.n}: ${c.status} (${buildFile(planning.repoPath, planning.slug, c.file)})`,
    );
  }
  for (const m of planning.meetings) {
    lines.push(
      `Meeting ${m.id}: ${m.status} (${buildFile(planning.repoPath, planning.slug, m.file)})`,
    );
  }
  const latest = planning.frozen.at(-1);
  lines.push(
    latest
      ? `Frozen plan: version ${latest.version} (${buildFile(planning.repoPath, planning.slug, latest.file)})`
      : "Frozen plan: none",
    `Draft plan, once the spec and the design exist: ${buildFile(planning.repoPath, planning.slug, "planning/draft.json")}`,
    `Status file: ${buildFile(planning.repoPath, planning.slug, "STATUS.md")}`,
    "",
  );
  return lines.join("\n");
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

/**
 * The headers that name the Claude Code session that runs the command, so
 * the engine can read the Project manager's usage from its transcript.
 * Empty outside a Claude Code session.
 */
export function sessionHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const id = env.CLAUDE_CODE_SESSION_ID;
  const config = env.CLAUDE_CONFIG_DIR || (env.HOME ? `${env.HOME}/.claude` : "");
  if (!id || !config.startsWith("/")) return {};
  return {
    [BUILD_SOCKET_SESSION_HEADERS.id]: id,
    [BUILD_SOCKET_SESSION_HEADERS.transcripts]: `${config.replace(/\/+$/, "")}/projects`,
  };
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
  } else if (command.kind === "meeting-end") {
    body = { ...body, meeting: command.meeting };
  } else if (command.kind === "freeze" && command.push !== null) {
    body.push = command.push;
  } else if (command.kind === "start" && command.base !== null) {
    body.base = command.base;
  } else if (command.kind === "messages") {
    body.direct = command.direct;
  } else if (command.kind === "inbox") {
    body.all = command.all;
  } else if (command.kind === "resolve") {
    body = { ...body, ...command.resolution };
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
        sessionHeaders(io.env),
      );
    const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
    if (command.kind === "plan") {
      const answer = await client.send("plan", body);
      io.stdout(command.json ? json(answer) : formatSeatAnswer(answer));
    } else if (
      command.kind === "meet" ||
      command.kind === "meeting-post" ||
      command.kind === "meeting-end"
    ) {
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
    } else if (command.kind === "inbox") {
      const inbox = await client.send("inbox", body);
      io.stdout(command.json ? json(inbox.items) : formatInbox(inbox, command.all));
    } else if (command.kind === "decisions") {
      const { decisions } = await client.send("decisions", body);
      io.stdout(command.json ? json(decisions) : formatDecisions(command.slug, decisions));
    } else if (command.kind === "status") {
      const answer = await client.send("status", body);
      if ("planning" in answer) {
        io.stdout(command.json ? json(answer.planning) : formatPlanning(answer.planning));
      } else {
        io.stdout(command.json ? json(answer.build) : formatBuild(answer.build));
      }
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
