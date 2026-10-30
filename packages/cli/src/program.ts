// The `agentbox` command tree.
import { spawn } from "node:child_process";
import path from "node:path";
import {
  DecisionOptionSchema,
  EffortSchema,
  PlatformSchema,
  ProfileSchema,
  RoleSchema,
  SeveritySchema,
  VerdictSchema,
  type BoxView,
  type Ceiling,
  type Finding,
  type Job,
  type ProjectSummary,
  type RunState,
  type SetupCheck,
} from "@agentbox/contracts";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { ApiCallError, ServerClient, ServerUnreachableError } from "./client.js";
import { tailEvents, type WebSocketCtor } from "./events.js";
import { jsonText, keyValues, percent, table, terminalText } from "./format.js";
import { checkAttachArgv, checkServerUrl, resolveSettings } from "./settings.js";

export interface CliDeps {
  env: Record<string, string | undefined>;
  home: string;
  out: (text: string) => void;
  err: (text: string) => void;
  fetch?: typeof fetch;
  /** Runs an attach command with the terminal; resolves with its exit code. */
  exec?: (argv: string[]) => Promise<number>;
  WebSocket?: WebSocketCtor;
  /** How often `box new` polls its job. */
  pollMs?: number;
  /** Stops `events`; Ctrl+C by default. */
  signal?: AbortSignal;
  /** The directory relative paths resolve against; the process's own by default. */
  cwd?: string;
}

/** A usage problem the CLI reports with exit code 2. */
export class UsageError extends Error {}

const PLATFORMS: string[] = PlatformSchema.options;
const EFFORTS: string[] = EffortSchema.options;
const PROFILES: string[] = ProfileSchema.options;
const ROLES: string[] = RoleSchema.options;
const VERDICTS: string[] = VerdictSchema.options;
const SEVERITIES: string[] = SeveritySchema.options;
const DECISIONS: string[] = DecisionOptionSchema.options;

function choice(values: string[]) {
  return (value: string) => {
    if (!values.includes(value)) {
      throw new InvalidArgumentError(`Use one of: ${values.join(", ")}.`);
    }
    return value;
  };
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("Use a positive whole number.");
  return n;
}

function nonNegativeInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new InvalidArgumentError("Use a whole number, 0 or more.");
  return n;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parsePortPair(spec: string): { host: number; container: number } {
  const [h, c = h] = spec.split(":");
  const host = Number(h);
  const container = Number(c);
  const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
  if (!ok(host) || !ok(container))
    throw new UsageError(`Invalid TCP map ${spec}; use HOST:CONTAINER.`);
  return { host, container };
}

/**
 * Parses `HOST[:CONTAINER]`. A relative host path resolves against `cwd`,
 * and a missing container path mirrors the resolved host path.
 */
function parseMount(spec: string, cwd: string): { host: string; container: string } {
  const i = spec.indexOf(":");
  const host = i < 0 ? spec : spec.slice(0, i);
  const container = i < 0 ? spec : spec.slice(i + 1);
  if (host === "" || container === "")
    throw new UsageError(`Invalid mount ${spec}; use HOST[:CONTAINER].`);
  const resolved = path.resolve(cwd, host);
  return { host: resolved, container: i < 0 ? resolved : container };
}

function ceilingText(c: Ceiling): string {
  return c.kind === "utilization" ? `${percent(c.max)} of ${c.window}` : `$${c.maxUsd}/${c.period}`;
}

function boxRows(boxes: BoxView[]) {
  return table(
    ["BOX", "STATUS", "REVIEW", "PLATFORM", "CONVERSATION", "PROJECT"],
    boxes.map((b) => [
      b.box.id,
      b.status,
      b.reviewState.state === "under_review" ? `run ${b.reviewState.runId}` : "",
      b.box.platform,
      b.box.conversationName,
      b.box.projectId,
    ]),
  );
}

function runRows(runs: RunState[]) {
  return table(
    ["RUN", "STATUS", "STAGE", "ROUND", "PROFILE", "BOX", "UPDATED"],
    runs.map((r) => [r.id, r.status, r.stage, r.round, r.profile, r.boxId, r.updatedAt]),
  );
}

function runDetail(r: RunState): string {
  return keyValues([
    ["Run", r.id],
    ["Status", r.status],
    ["Stage", r.stage],
    ["Round", r.round],
    ["Profile", r.profile],
    ["Project", r.projectId],
    ["Box", r.boxId],
    ["Repository", r.request.repoPath],
    ["Range", `${r.request.base}${r.request.mergeBase ? "..." : ".."}${r.request.tip ?? "HEAD"}`],
    ["Reviewers", r.roles.reviewer.join(", ")],
    ["Disprover", r.roles.disprover],
    ["Confirmer", r.roles.confirmer],
    ["Fixer", r.roles.fixer],
    ["Stop reason", r.stopReason],
    ["Decision", r.decision ? `${r.decision.kind}: ${r.decision.message}` : null],
    ["Paused until", r.pausedUntil],
    ["Pull request", r.prUrl],
    ["Error", r.error],
  ]);
}

function findingRows(findings: Finding[]) {
  return table(
    ["ID", "SEV", "VERDICT", "ROUND", "LOCATION", "TITLE"],
    findings.map((f) => [
      f.id,
      f.severity,
      f.verdict,
      f.round,
      f.file ? (f.lines ? `${f.file}:${f.lines[0]}-${f.lines[1]}` : f.file) : null,
      f.title,
    ]),
  );
}

function checkRows(checks: SetupCheck[]) {
  return table(
    ["CHECK", "STATUS", "MESSAGE"],
    checks.map((c) => [c.id, c.status, c.message]),
  );
}

function projectRows(projects: ProjectSummary[]) {
  return table(
    ["PROJECT", "NAME", "ROOT", "RUNNING", "TOTAL", "CONTAINER", "ENGINE"],
    projects.map((p) => [
      p.project.id,
      p.project.name,
      p.project.root,
      p.running,
      p.total,
      p.container ? `${p.container.name} (${p.container.state})` : null,
      p.container?.engine
        ? `${p.container.engine.version ?? "?"}${p.container.engine.healthy ? "" : " unhealthy"}${
            p.container.engine.versionMatches === false ? " mismatch" : ""
          }`
        : null,
    ]),
  );
}

/** Variables that hold the server token, which no child of the CLI needs. */
const TOKEN_ENV = ["AGENTBOX_TOKEN", "AGENTBOX_SERVER_TOKEN"];

/** `env` without the server token, for a child such as the attach command. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of TOKEN_ENV) delete out[name];
  return out;
}

function defaultExec(argv: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const [program, ...args] = argv as [string, ...string[]];
    const child = spawn(program, args, { stdio: "inherit", env: childEnv() });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

/** Builds the command tree. `state.code` receives the exit code of the command that ran. */
export function buildProgram(deps: CliDeps, state: { code: number }): Command {
  const program = new Command("agentbox")
    .description("Manage Agent Box boxes, projects, and code review runs from the terminal.")
    .option("--json", "Print the server's JSON instead of a table.")
    .option(
      "--server <url>",
      "The server URL. Default: $AGENTBOX_SERVER or http://127.0.0.1:21400.",
    )
    .option(
      "--insecure",
      "Allow a plain http server URL on another host. The token then crosses the network unencrypted.",
    )
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: deps.out, writeErr: deps.err });

  const globals = () => program.opts<{ json?: boolean; server?: string; insecure?: boolean }>();
  const settings = () => {
    const s = resolveSettings({ env: deps.env, home: deps.home, server: globals().server });
    const problem = checkServerUrl(s.baseUrl, globals().insecure ?? false);
    if (problem) throw new UsageError(problem);
    return s;
  };
  const client = () => {
    const s = settings();
    return new ServerClient({ baseUrl: s.baseUrl, token: s.token, fetch: deps.fetch });
  };
  /** Prints raw JSON with `--json`, or the text form. */
  const print = (json: unknown, text: () => string) => {
    deps.out(globals().json ? `${jsonText(json, 2)}\n` : terminalText(text()));
  };
  const exec = deps.exec ?? defaultExec;
  // The server resolves nothing against its own working directory, so every
  // path leaves the CLI absolute.
  const cwd = deps.cwd ?? process.cwd();
  const absolute = (p: string) => path.resolve(cwd, p);

  // -------------------------------------------------------------------------
  // box
  const box = program.command("box").description("Create, start, stop, and attach to boxes.");

  box
    .command("list")
    .description("List boxes.")
    .option("--project <id>", "Only boxes in this project.")
    .action(async (o: { project?: string }) => {
      const r = await client().call("boxes.list", { query: { projectId: o.project } });
      print(r, () => boxRows(r.boxes));
    });

  box
    .command("new")
    .description("Create a box for a directory and start it.")
    .argument("<dir>", "The target directory.")
    .option("-n, --name <name>", "The conversation name.", "")
    .addOption(
      new Option("--platform <platform>", "The CLI to run.").choices(PLATFORMS).default("claude"),
    )
    .option("--model <model>", "The --model to pass; absent leaves it to the settings files.")
    .addOption(new Option("--effort <effort>", "The --effort to pass.").choices(EFFORTS))
    .addOption(
      new Option("--layout <layout>", "Where the agent works.")
        .choices(["worktree", "workspace", "root", "auto"])
        .default("auto"),
    )
    .option("--remember-layout", "Store the layout as the default for the directory.")
    .option("--adopt <uuid>", "Resume this existing conversation.")
    .option("--fork <boxId>", "Fork this box's conversation.")
    .option("--no-skip-permissions", "Don't make bypass permissions available.")
    .option("--no-start", "Save the box without starting it.")
    .option("--force", "Adopt a conversation that a stopped box holds.")
    .option("--ssh-remote <name>", "An SSH remote to forward (repeatable).", collect, [])
    .option("--no-wait", "Print the job and return without waiting for it.")
    .action(async (dir: string, o) => {
      if (o.adopt && o.fork) throw new UsageError("Use --adopt or --fork, not both.");
      const c = client();
      const conversation = o.adopt
        ? { mode: "adopt" as const, sessionUuid: o.adopt as string }
        : o.fork
          ? { mode: "fork" as const, fromBoxId: o.fork as string }
          : { mode: "new" as const };
      let job: Job = await c.call("boxes.create", {
        body: {
          targetDir: absolute(dir),
          platform: o.platform,
          conversationName: o.name,
          conversation,
          model: o.model,
          effort: o.effort,
          skipPermissions: o.skipPermissions,
          layout: o.layout,
          rememberLayout: o.rememberLayout ?? false,
          sshRemoteRefs: o.sshRemote,
          start: o.start,
          force: o.force ?? false,
        },
      });
      while (o.wait && job.status === "running") {
        await new Promise((r) => setTimeout(r, deps.pollMs ?? 1_000));
        job = await c.call("jobs.get", { params: { jobId: job.id } });
      }
      if (job.status === "failed") {
        state.code = 1;
        deps.err(
          terminalText(
            `Box creation failed: ${job.error?.message ?? `exit code ${job.exitCode}`}\n`,
          ),
        );
        if (globals().json) deps.out(`${jsonText(job, 2)}\n`);
        return;
      }
      print(job, () =>
        job.status === "running"
          ? `Creating ${job.boxId ?? "the box"} (job ${job.id}).\n`
          : `Created ${job.boxId ?? "the box"}.\n`,
      );
    });

  for (const [name, key, verb] of [
    ["start", "boxes.start", "Start"],
    ["stop", "boxes.stop", "Stop"],
    ["restart", "boxes.restart", "Restart"],
  ] as const) {
    box
      .command(name)
      .description(`${verb} a box's session.`)
      .argument("<boxId>")
      .action(async (boxId: string) => {
        const v = await client().call(key, { params: { boxId } });
        print(v, () => `${v.box.id} is ${v.status}.\n`);
      });
  }

  box
    .command("remove")
    .description("Remove a stopped box from the dashboard; the conversation stays.")
    .argument("<boxId>")
    .option("--remove-worktree", "Also remove the box's worktree when it's clean.")
    .action(async (boxId: string, o: { removeWorktree?: boolean }) => {
      const r = await client().call("boxes.remove", {
        params: { boxId },
        query: { removeWorktree: o.removeWorktree ? "true" : "false" },
      });
      print(
        r,
        () =>
          `${r.removed ? `Removed ${boxId}.` : `Kept ${boxId}.`} Worktree: ${r.worktree}${
            r.reason ? ` (${r.reason})` : ""
          }.\n`,
      );
    });

  box
    .command("purge")
    .description("Delete the transcripts and records for the box's directory. Can't be undone.")
    .argument("<boxId>")
    .option("--yes", "Confirm the purge.")
    .option("--dry-run", "Report what the purge would delete without deleting it.")
    .action(async (boxId: string, o: { yes?: boolean; dryRun?: boolean }) => {
      if (!o.yes && !o.dryRun)
        throw new UsageError("Purge deletes transcripts. Run it again with --yes to confirm.");
      const r = await client().call("boxes.purge", {
        params: { boxId },
        body: { dryRun: o.dryRun ?? false },
      });
      print(
        r,
        () =>
          `${r.dryRun ? "Would remove" : "Removed"} ${r.removedRecords.length} records and ${r.removedTranscriptDirs.length} transcript directories.\n`,
      );
    });

  const attach = async (boxId: string, kind: "session" | "side" | "shell", platform?: string) => {
    const r = await client().call("boxes.attachCommand", {
      params: { boxId },
      query: { kind, platform: platform as "claude" | undefined },
    });
    const problem = checkAttachArgv(r.argv);
    if (problem) throw new UsageError(problem);
    state.code = await exec(r.argv);
  };

  box
    .command("open")
    .description("Start a box when it's stopped, then attach to its session.")
    .argument("<boxId>")
    .action(async (boxId: string) => {
      const c = client();
      const v = await c.call("boxes.get", { params: { boxId } });
      if (v.status === "stopped") await c.call("boxes.start", { params: { boxId } });
      await attach(boxId, "session");
    });

  box
    .command("attach")
    .description("Attach this terminal to a box's session.")
    .argument("<boxId>")
    .addOption(
      new Option("--side <platform>", "Attach to a side session instead.").choices(PLATFORMS),
    )
    .action((boxId: string, o: { side?: string }) =>
      attach(boxId, o.side ? "side" : "session", o.side),
    );

  box
    .command("shell")
    .description("Open a shell in the box's container.")
    .argument("<boxId>")
    .action((boxId: string) => attach(boxId, "shell"));

  box
    .command("message")
    .description("Send one message to the box's interactive session.")
    .argument("<boxId>")
    .argument("<text...>")
    .action(async (boxId: string, text: string[]) => {
      const r = await client().call("boxes.message", {
        params: { boxId },
        body: { text: text.join(" ") },
      });
      print(r, () => `Sent.\n`);
    });

  // -------------------------------------------------------------------------
  // project
  const project = program.command("project").description("List and change projects.");

  project
    .command("list")
    .description("List projects with box counts.")
    .action(async () => {
      const r = await client().call("projects.list");
      print(r, () => projectRows(r.projects));
    });

  project
    .command("show")
    .description("Show a project's settings.")
    .argument("<projectId>")
    .action(async (projectId: string) => {
      const r = await client().call("projects.get", { params: { projectId } });
      const p = r.project;
      print(r, () =>
        keyValues([
          ["Project", p.id],
          ["Name", p.name],
          ["Root", p.root],
          ["Primary repository", p.primaryRepo],
          ["Boxes", `${r.running} running of ${r.total}`],
          ["Container", r.container ? `${r.container.name} (${r.container.state})` : null],
          ["TCP maps", p.tcpMaps.map((m) => `${m.host}:${m.container}`).join(", ")],
          ["Mounts", p.mounts.map((m) => `${m.host}:${m.container}`).join(", ")],
          ["Secrets", p.secretRefs.map((s) => s.name).join(", ")],
          ["Policy", p.policyPath],
        ]),
      );
    });

  project
    .command("set")
    .description("Change a project's settings.")
    .argument("<projectId>")
    .option("--name <name>", "The display name.")
    .option("--primary-repo <path>", "The primary repository.")
    .option("--clear-primary-repo", "Remove the primary repository.")
    .option("--policy-path <path>", "The policy file, relative to the root.")
    .option("--tcp-map <host:container>", "A TCP map (repeatable); replaces the list.", collect)
    .option("--clear-tcp-maps", "Remove every TCP map.")
    .option("--mount <host[:container]>", "A mount (repeatable); replaces the list.", collect)
    .option("--clear-mounts", "Remove every mount.")
    .option("--clear-ceilings", "Remove the project's ceilings override.")
    .action(async (projectId: string, o) => {
      const body: Record<string, unknown> = {};
      if (o.name !== undefined) body.name = o.name;
      if (o.primaryRepo !== undefined) body.primaryRepo = absolute(o.primaryRepo as string);
      if (o.clearPrimaryRepo) body.primaryRepo = null;
      if (o.policyPath !== undefined) body.policyPath = o.policyPath;
      if (o.tcpMap) body.tcpMaps = (o.tcpMap as string[]).map(parsePortPair);
      if (o.clearTcpMaps) body.tcpMaps = [];
      if (o.mount) body.mounts = (o.mount as string[]).map((m) => parseMount(m, cwd));
      if (o.clearMounts) body.mounts = [];
      if (o.clearCeilings) body.ceilingsOverride = null;
      if (Object.keys(body).length === 0)
        throw new UsageError("Give at least one setting to change.");
      const r = await client().call("projects.update", { params: { projectId }, body });
      print(
        r,
        () =>
          `Updated ${r.project.id}.\n` +
          (r.staleBoxes.length > 0
            ? `Restart the container to apply the change to: ${r.staleBoxes.join(", ")}.\n`
            : ""),
      );
    });

  // -------------------------------------------------------------------------
  // review
  const review = program.command("review").description("Start and control code review runs.");

  review
    .command("start")
    .description("Start a review run.")
    .option("--box <boxId>", "Review this box's working tree and branch.")
    .option("--project <projectId>", "The project; implied by --box.")
    .option(
      "--repo <path>",
      "The repository as the container sees it, relative to the current directory; implied by --box.",
    )
    .option("--base <ref>", "The base ref, or `pr` for the pull request's base.", "origin/main")
    .option("--tip <branch>", "The branch to review; default the checked-out branch.")
    .option("--exact-base", "Diff from the base commit, not the merge base.")
    .option("--read-only", "Review without fixing.")
    .option("--include-worktree", "Review uncommitted changes instead of refusing a dirty tree.")
    .addOption(new Option("--profile <profile>").choices(PROFILES).default("offload"))
    .addOption(
      new Option("--pipeline <pipeline>").choices(["pre-push", "post-push"]).default("pre-push"),
    )
    .option("--pr <number>", "The pull request, for post-push.", positiveInt)
    .option("--no-cross-vendor", "Let the same vendor disprove and confirm its own work.")
    .option("--round-cap <n>", "Stop after this many rounds.", positiveInt)
    .option(
      "--continuation-cap <n>",
      "Ask each reviewer to continue at most this many times per round.",
      nonNegativeInt,
    )
    .action(async (o) => {
      const c = client();
      let projectId: string | undefined = o.project;
      let repoPath: string | undefined = o.repo === undefined ? undefined : absolute(o.repo);
      let tip: string | undefined = o.tip;
      if (o.box) {
        const v = await c.call("boxes.get", { params: { boxId: o.box } });
        projectId ??= v.box.projectId;
        repoPath ??= v.box.worktree ?? v.box.targetDir;
        tip ??= v.box.branch;
      }
      if (!projectId || !repoPath) {
        throw new UsageError("Give --box, or both --project and --repo.");
      }
      const run = await c.call("runs.create", {
        body: {
          projectId,
          boxId: o.box,
          repoPath,
          base: o.base,
          tip,
          exactBase: o.exactBase ?? false,
          readOnly: o.readOnly ?? false,
          includeWorktree: o.includeWorktree ?? false,
          profile: o.profile,
          pipeline: o.pipeline,
          prNumber: o.pr,
          crossVendor: o.crossVendor,
          roundCap: o.roundCap,
          continuationCap: o.continuationCap,
        },
      });
      print(run, () => `Started run ${run.id}.\n`);
    });

  review
    .command("status")
    .description("List runs, or show one run with its rounds.")
    .argument("[runId]")
    .option("--project <projectId>", "Only runs in this project.")
    .option("--box <boxId>", "Only runs for this box.")
    .action(async (runId: string | undefined, o: { project?: string; box?: string }) => {
      const c = client();
      if (!runId) {
        const r = await c.call("runs.list", { query: { projectId: o.project, boxId: o.box } });
        print(r, () => runRows(r.runs));
        return;
      }
      const [run, rounds] = await Promise.all([
        c.call("runs.get", { params: { runId } }),
        c.call("runs.rounds", { params: { runId } }),
      ]);
      print({ run, rounds: rounds.rounds }, () => {
        const text = runDetail(run);
        if (rounds.rounds.length === 0) return text;
        return (
          text +
          "\n" +
          table(
            ["ROUND", "FIXED", "OVERLAP", "COST", "VENDORS"],
            rounds.rounds.map((r) => [
              r.round,
              r.fixed,
              percent(r.overlapRate),
              `$${r.costUsd.toFixed(2)}`,
              Object.entries(r.perVendor)
                .map(([v, s]) => `${v} ${s?.confirmed ?? 0}/${s?.raised ?? 0}`)
                .join(", "),
            ]),
          )
        );
      });
    });

  for (const [name, key, done] of [
    ["pause", "runs.pause", "Pausing"],
    ["resume", "runs.resume", "Resumed"],
    ["cancel", "runs.cancel", "Cancelled"],
  ] as const) {
    review
      .command(name)
      .description(`${name[0]?.toUpperCase()}${name.slice(1)} a run.`)
      .argument("<runId>")
      .action(async (runId: string) => {
        const r = await client().call(key, { params: { runId } });
        print(r, () => `${done} run ${r.id}; status ${r.status}.\n`);
      });
  }

  review
    .command("push")
    .description(
      "Push a run's branch, open or update its pull request, and start the post-push loop.",
    )
    .argument("<runId>")
    .option("--title <text>", "The pull request title; default the server's choice.")
    .option("--draft", "Open the pull request as a draft.")
    .action(async (runId: string, o: { title?: string; draft?: boolean }) => {
      const r = await client().call("runs.push", {
        params: { runId },
        body: { title: o.title, draft: o.draft ?? false },
      });
      print(r, () => `Pushed run ${r.id}; status ${r.status}, stage ${r.stage}.\n`);
    });

  review
    .command("assign")
    .description("Give a role to one or more vendors from the next round.")
    .argument("<runId>")
    .argument("<role>", `One of ${ROLES.join(", ")}.`, choice(ROLES))
    .argument("<vendors...>", `One or more of ${PLATFORMS.join(", ")}.`)
    .action(async (runId: string, role: string, vendors: string[]) => {
      const unknown = vendors.filter((v) => !PLATFORMS.includes(v));
      if (unknown.length > 0) {
        throw new UsageError(`Unknown vendor ${unknown.join(", ")}; use ${PLATFORMS.join(", ")}.`);
      }
      const r = await client().call("runs.assign", {
        params: { runId },
        body: { role: role as "reviewer", vendors: vendors as ["claude"] },
      });
      print(r, () => `Assigned ${role} to ${vendors.join(", ")} from the next round.\n`);
    });

  review
    .command("profile")
    .description("Switch a run's profile from the next round.")
    .argument("<runId>")
    .argument("<profile>", `One of ${PROFILES.join(", ")}.`, choice(PROFILES))
    .action(async (runId: string, profile: string) => {
      const r = await client().call("runs.profile", {
        params: { runId },
        body: { profile: profile as "offload" },
      });
      print(r, () => `Run ${r.id} switches to ${profile} from the next round.\n`);
    });

  review
    .command("usage")
    .description("Show each vendor's usage against its ceiling.")
    .action(async () => {
      const r = await client().call("usage.get");
      print(r, () =>
        table(
          ["VENDOR", "ACCOUNT", "WINDOW", "USED", "CEILING", "OVER", "RESETS", "FORECAST"],
          r.vendors.map((v) => {
            const sample = v.latest.find((s) => s.window === v.window) ?? v.latest[0];
            const used = sample
              ? sample.spendUsd !== null
                ? `$${sample.spendUsd.toFixed(2)}`
                : percent(sample.utilization)
              : null;
            return [
              v.vendor,
              v.account,
              v.window,
              used,
              ceilingText(v.ceiling),
              v.overCeiling ? "yes" : "no",
              v.resetAt,
              v.forecastAt,
            ];
          }),
        ),
      );
    });

  review
    .command("findings")
    .description("List a run's findings.")
    .argument("<runId>")
    .addOption(new Option("--verdict <verdict>").choices(VERDICTS))
    .addOption(new Option("--severity <severity>").choices(SEVERITIES))
    .option("--round <n>", "Only findings from this round.", positiveInt)
    .action(async (runId: string, o: { verdict?: string; severity?: string; round?: number }) => {
      const r = await client().call("findings.list", {
        params: { runId },
        query: { verdict: o.verdict as "pending", severity: o.severity as "P1", round: o.round },
      });
      print(r, () => findingRows(r.findings));
    });

  review
    .command("decide")
    .description("Answer the decision a run waits for.")
    .argument("<runId>")
    .argument("<option>", `One of ${DECISIONS.join(", ")}.`, choice(DECISIONS))
    .option(
      "--waive <findingId>",
      "A finding to waive with resume_waive (repeatable).",
      collect,
      [],
    )
    .option("--reason <text>", "Why, for the run's history.")
    .action(async (runId: string, option: string, o: { waive: string[]; reason?: string }) => {
      if (option === "resume_waive" && o.waive.length === 0) {
        throw new UsageError("resume_waive needs at least one --waive FINDING_ID.");
      }
      const r = await client().call("runs.decide", {
        params: { runId },
        body: { option: option as "resume", waiveFindingIds: o.waive, reason: o.reason },
      });
      print(r, () => `Run ${r.id} is ${r.status}.\n`);
    });

  // -------------------------------------------------------------------------
  // migrate, setup, doctor, events
  program
    .command("migrate")
    .description("Import the 3.x records under ~/.claude-box into the server's database.")
    .option("--dry-run", "Report what would be imported without writing.")
    .action(async (o: { dryRun?: boolean }) => {
      const r = await client().call("import.run", { body: { dryRun: o.dryRun ?? false } });
      print(r, () => {
        const verb = r.dryRun ? "Would import" : "Imported";
        const settings = r.settingsApplied ? "the global settings" : "no global settings";
        const lines = [
          `${verb} ${r.projects} projects, ${r.boxes} boxes, ${r.sshRemotes} SSH remotes, and ${settings}.`,
          ...r.warnings.map((w) => `Warning: ${w}`),
        ];
        return `${lines.join("\n")}\n`;
      });
    });

  program
    .command("setup")
    .description("Run the setup checks and print them.")
    .action(async () => {
      const r = await client().call("setup.get");
      print(r, () => checkRows(r.checks));
    });

  program
    .command("doctor")
    .description("Check the server, the token, Docker, the image, and the engines.")
    .action(async () => {
      const s = settings();
      const c = client();
      type Row = { check: string; status: "ok" | "warn" | "fail"; detail: string };
      const rows: Row[] = [];
      const add = (check: string, status: Row["status"], detail: string) =>
        rows.push({ check, status, detail });
      const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

      let reachable = false;
      try {
        const h = await c.call("health");
        reachable = true;
        add("server", "ok", `${s.baseUrl}, version ${h.version}`);
      } catch (e) {
        add("server", "fail", describe(e));
      }
      if (reachable) {
        if (s.token === null) {
          add("token", "fail", `No token in AGENTBOX_TOKEN or ${s.tokenFile}.`);
        } else {
          try {
            const setup = await c.call("setup.get");
            add("token", "ok", s.tokenSource === "file" ? s.tokenFile : "AGENTBOX_TOKEN");
            for (const id of ["docker", "image", "engine"] as const) {
              const check = setup.checks.find((x) => x.id === id);
              if (check) add(id, check.status, check.message);
            }
            const image = await c.call("image.status");
            add(
              "image version",
              image.engineMatches ? "ok" : "fail",
              image.exists
                ? `engine ${image.engineVersion ?? "unknown"}, server expects ${image.expectedEngineVersion}`
                : `${image.name} doesn't exist`,
            );
            const projects = await c.call("projects.list");
            for (const p of projects.projects) {
              const engine = p.container?.engine;
              if (!p.container || p.container.state !== "running" || !engine) continue;
              const ok = engine.healthy && engine.versionMatches !== false;
              add(
                `engine ${p.project.id}`,
                ok ? "ok" : "fail",
                `${p.container.name}: ${engine.healthy ? "healthy" : "not answering"}, version ${
                  engine.version ?? "unknown"
                }${engine.versionMatches === false ? " (mismatch)" : ""}`,
              );
            }
          } catch (e) {
            add(
              e instanceof ApiCallError && e.status === 401 ? "token" : "server checks",
              "fail",
              describe(e),
            );
          }
        }
      }
      if (rows.some((r) => r.status === "fail")) state.code = 1;
      print({ checks: rows }, () =>
        table(
          ["CHECK", "STATUS", "DETAIL"],
          rows.map((r) => [r.check, r.status, r.detail]),
        ),
      );
    });

  program
    .command("events")
    .description("Print the server's event stream as JSON lines until interrupted.")
    .option("--types <types>", "Comma-separated event types to receive.")
    .option("--count <n>", "Exit after this many events.", positiveInt)
    .action(async (o: { types?: string; count?: number }) => {
      const s = settings();
      if (s.token === null)
        throw new ApiCallError(
          401,
          "unauthorized",
          `No token in AGENTBOX_TOKEN or ${s.tokenFile}.`,
        );
      await tailEvents({
        baseUrl: s.baseUrl,
        token: s.token,
        types: o.types,
        count: o.count,
        write: deps.out,
        WebSocket: deps.WebSocket,
        signal: deps.signal,
      });
    });

  return program;
}

/** Runs the CLI and returns the exit code. Never throws. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const state = { code: 0 };
  const program = buildProgram(deps, state);
  try {
    await program.parseAsync(argv, { from: "user" });
    return state.code;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Commander has already printed help or the usage problem.
      return err.code === "commander.helpDisplayed" ||
        err.code === "commander.version" ||
        err.exitCode === 0
        ? 0
        : 2;
    }
    if (err instanceof UsageError) {
      deps.err(`${err.message}\n`);
      return 2;
    }
    if (err instanceof ApiCallError) {
      deps.err(terminalText(`Error (${err.code}): ${err.message}\n`));
      if (err.details !== undefined && program.opts().json) {
        deps.err(`${jsonText(err.details, 2)}\n`);
      }
      return 1;
    }
    if (err instanceof ServerUnreachableError) {
      deps.err(`${err.message}\nStart it with: systemctl --user start agentbox-server\n`);
      return 1;
    }
    deps.err(terminalText(`${err instanceof Error ? err.message : String(err)}\n`));
    return 1;
  }
}
