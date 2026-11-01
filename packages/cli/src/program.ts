// The `aio` command tree.
import { spawn } from "node:child_process";
import path from "node:path";
import {
  ACCOUNT_DIR_ENV,
  ACCOUNT_SIGN_IN_COMMAND,
  AccountSeedReportSchema,
  DEFAULT_SEED_ACCOUNT_NAME,
  DecisionOptionSchema,
  EffortSchema,
  PlatformSchema,
  ProfileSchema,
  READ_ONLY_POST_PUSH_MESSAGE,
  RoleSchema,
  SeveritySchema,
  VerdictSchema,
  isReadOnlyPostPush,
  parseAccountId,
  type AccountSeedReport,
  type AccountSignIn,
  type AccountView,
  type BoxView,
  type Ceiling,
  type ContainerInfo,
  type Finding,
  type Job,
  type ProjectSummary,
  type RunState,
  type SetupCheck,
} from "@aio/contracts";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import {
  ApiCallError,
  InterruptedError,
  RequestInputError,
  ServerClient,
  ServerUnreachableError,
} from "./client.js";
import { tailEvents, type WebSocketCtor } from "./events.js";
import { jsonText, keyValues, percent, table, terminalText } from "./format.js";
import {
  checkAttachArgv,
  checkServerUrl,
  displayUrl,
  resolveSettings,
  serverFetch,
  serverTls,
  type CliSettings,
} from "./settings.js";

export interface CliDeps {
  env: Record<string, string | undefined>;
  home: string;
  out: (text: string) => void;
  err: (text: string) => void;
  fetch?: typeof fetch;
  /** Runs an attach command with the terminal; resolves with its exit code. */
  exec?: (argv: string[]) => Promise<number>;
  WebSocket?: WebSocketCtor;
  /** How often `box new` and `accounts seed` poll their job. */
  pollMs?: number;
  /**
   * Stops the running command: `events` ends cleanly, and any other command
   * stops its request or job polling and exits 130. Ctrl+C by default.
   */
  signal?: AbortSignal;
  /** The directory relative paths resolve against; the process's own by default. */
  cwd?: string;
}

/** A usage problem the CLI reports with exit code 2. */
export class UsageError extends Error {}

const PLATFORMS: string[] = PlatformSchema.options;

/** Turns repeated `--account VENDOR/NAME` options into the `accounts` body field. */
function accountsOf(ids: readonly string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const parsed = parseAccountId(id);
    if (!parsed) {
      throw new UsageError(`Invalid account ${id}; use VENDOR/NAME, such as claude/work.`);
    }
    if (out[parsed.vendor] !== undefined) {
      throw new UsageError(`Two ${parsed.vendor} accounts given; a box uses one per vendor.`);
    }
    out[parsed.vendor] = id;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
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
  const parts = spec.split(":");
  if (parts.length > 2) throw new UsageError(`Invalid TCP map ${spec}; use HOST:CONTAINER.`);
  const [h, c = h] = parts;
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

function signInText(s: AccountSignIn): string {
  const state =
    s.state === "signed_in"
      ? "signed in"
      : s.state === "not_signed_in"
        ? "not signed in"
        : "sign-in unknown";
  return s.identity ? `${state} as ${s.identity}` : state;
}

function accountRows(views: AccountView[]) {
  return table(
    ["ACCOUNT", "LABEL", "DEFAULT", "SIGN-IN", "FOLDER"],
    views.map((v) => [
      v.account.id,
      v.account.label,
      v.isDefault ? "yes" : "",
      signInText(v.account.signIn),
      v.dirExists ? v.dir : `${v.dir} (missing)`,
    ]),
  );
}

function seedText(report: AccountSeedReport): string {
  const lines: string[] = [];
  for (const a of report.accounts) {
    if (a.status === "skipped") {
      lines.push(`Skipped ${a.id}: ${a.reason ?? "no host folder"}`);
      continue;
    }
    const verb = a.status === "would_seed" ? "Would seed" : "Seeded";
    const mib = (a.bytes / (1024 * 1024)).toFixed(1);
    lines.push(
      `${verb} ${a.id} from ${a.source}: ${a.files} files (${mib} MiB), ${a.symlinks} links.`,
    );
    if (a.leftOut.length > 0) lines.push(`  Left out the sign-in files: ${a.leftOut.join(", ")}.`);
    if (a.skippedSpecial.length > 0) {
      lines.push(`  Skipped sockets and pipes: ${a.skippedSpecial.join(", ")}.`);
    }
    if (a.madeDefault) lines.push(`  Default ${a.vendor} account.`);
    if (a.usageRelabeled > 0) lines.push(`  Relabeled ${a.usageRelabeled} usage samples.`);
  }
  if (!report.dryRun && report.accounts.some((a) => a.status === "seeded")) {
    lines.push("Each account is not signed in. Sign in to it once from a box.");
  }
  return `${lines.join("\n")}\n`;
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
    ...(r.notices ?? []).map((n): [string, string] => ["Notice", n]),
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

/** A container's name and state, with `stale` when it runs with old settings. */
function containerCell(c: ContainerInfo): string {
  return `${c.name} (${c.state}${c.stale && c.stale.length > 0 ? ", stale" : ""})`;
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
      p.container ? containerCell(p.container) : null,
      p.container?.engine
        ? `${p.container.engine.version ?? "?"}${p.container.engine.healthy ? "" : " unhealthy"}${
            p.container.engine.versionMatches === false ? " mismatch" : ""
          }`
        : null,
    ]),
  );
}

/** Variables that hold the server token, which no child of the CLI needs. */
const TOKEN_ENV = ["AIO_TOKEN", "AIO_SERVER_TOKEN"];

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
  const program = new Command("aio")
    .description("Manage AI Orchestrator boxes, projects, and code review runs from the terminal.")
    .option("--json", "Print the server's JSON instead of a table.")
    .option("--server <url>", "The server URL. Default: $AIO_SERVER or https://127.0.0.1:21400.")
    .option(
      "--insecure",
      "Allow a plain http server URL. The token then travels unencrypted to whatever answers.",
    )
    .option(
      "--data-dir <path>",
      "The server's data directory, as passed to aio-server. Default: $AIO_DATA_DIR or ~/.ai-orchestrator.",
    )
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: deps.out, writeErr: deps.err });

  const globals = () =>
    program.opts<{ json?: boolean; server?: string; insecure?: boolean; dataDir?: string }>();
  // The server resolves nothing against its own working directory, so every
  // path leaves the CLI absolute.
  const cwd = deps.cwd ?? process.cwd();
  const absolute = (p: string) => path.resolve(cwd, p);
  const unchecked = () => {
    const dataDir = globals().dataDir;
    return resolveSettings({
      env: deps.env,
      home: deps.home,
      server: globals().server,
      dataDir: dataDir === undefined ? undefined : absolute(dataDir),
    });
  };
  /** Why the CLI refuses the server URL in `s`, or `null`. */
  const urlProblem = (s: CliSettings) =>
    checkServerUrl(s.baseUrl, globals().insecure ?? false, s.token !== null);
  const settings = () => {
    const s = unchecked();
    const problem = urlProblem(s);
    if (problem) throw new UsageError(problem);
    return s;
  };
  /** A client for `s`, which must have passed `urlProblem()`. */
  const clientFor = (s: CliSettings) =>
    new ServerClient({
      baseUrl: s.baseUrl,
      token: s.token,
      fetch: deps.fetch ?? serverFetch(s),
      signal: deps.signal,
    });
  const client = () => clientFor(settings());
  /** Prints raw JSON with `--json`, or the text form. */
  const print = (json: unknown, text: () => string) => {
    deps.out(globals().json ? `${jsonText(json, 2)}\n` : terminalText(text()));
  };
  const exec = deps.exec ?? defaultExec;
  /** Waits `pollMs`, or throws `InterruptedError` when `deps.signal` aborts first. */
  const pause = () =>
    new Promise<void>((resolve, reject) => {
      const signal = deps.signal;
      if (signal?.aborted) return reject(new InterruptedError());
      const onAbort = () => {
        clearTimeout(timer);
        reject(new InterruptedError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, deps.pollMs ?? 1_000);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  /** Polls `job` until it ends, or returns it at once when `wait` is false. */
  const waitForJob = async (c: ServerClient, job: Job, wait: boolean): Promise<Job> => {
    while (wait && job.status === "running") {
      await pause();
      job = await c.call("jobs.get", { params: { jobId: job.id } });
    }
    return job;
  };

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
    .option(
      "--account <id>",
      "The account for a vendor, VENDOR/NAME (repeatable). Default: the vendor's default.",
      collect,
      [],
    )
    .option("--no-wait", "Print the job and return without waiting for it.")
    .action(async (dir: string, o) => {
      if (o.adopt && o.fork) throw new UsageError("Use --adopt or --fork, not both.");
      const accountChoice = accountsOf(o.account as string[]);
      const c = client();
      const conversation = o.adopt
        ? { mode: "adopt" as const, sessionUuid: o.adopt as string }
        : o.fork
          ? { mode: "fork" as const, fromBoxId: o.fork as string }
          : { mode: "new" as const };
      const created: Job = await c.call("boxes.create", {
        body: {
          targetDir: absolute(dir),
          platform: o.platform,
          conversationName: o.name,
          conversation,
          model: o.model,
          effort: o.effort,
          skipPermissions: o.skipPermissions,
          ...(accountChoice ? { accounts: accountChoice } : {}),
          layout: o.layout,
          rememberLayout: o.rememberLayout ?? false,
          sshRemoteRefs: o.sshRemote,
          start: o.start,
          force: o.force ?? false,
        },
      });
      const job = await waitForJob(c, created, o.wait);
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

  box
    .command("start")
    .description("Start a box's session.")
    .argument("<boxId>")
    .option("--force", "Start it even when its container runs with stale mounts.")
    .action(async (boxId: string, o: { force?: boolean }) => {
      const v = await client().call("boxes.start", {
        params: { boxId },
        body: { force: o.force ?? false },
      });
      print(v, () => `${v.box.id} is ${v.status}.\n`);
    });

  for (const [name, key, verb] of [
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
    .command("account")
    .description("Set a box's account for a vendor, or use the default again with a bare vendor.")
    .argument("<boxId>")
    .argument("<account>", "VENDOR/NAME to set; VENDOR alone to use the default again.")
    .action(async (boxId: string, account: string) => {
      const vendor = account.split("/")[0] ?? "";
      if (!PLATFORMS.includes(vendor)) {
        throw new UsageError(`Unknown vendor ${vendor}; use ${PLATFORMS.join(", ")}.`);
      }
      const set = account.includes("/");
      if (set && !parseAccountId(account)) {
        throw new UsageError(`Invalid account ${account}; use VENDOR/NAME, such as claude/work.`);
      }
      const r = await client().call("boxes.update", {
        params: { boxId },
        body: { accounts: { [vendor]: set ? account : null } },
      });
      print(
        r,
        () =>
          `${boxId} now uses ${set ? account : `the default ${vendor} account`}.${
            r.restartRequired ? " Restart the box to apply it." : ""
          }\n`,
      );
    });

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

  /** Gets the attach command and checks it; throws a `UsageError` when the CLI won't run it. */
  const attachArgv = async (
    boxId: string,
    kind: "session" | "side" | "shell",
    platform?: string,
  ) => {
    const r = await client().call("boxes.attachCommand", {
      params: { boxId },
      query: { kind, platform: platform as "claude" | undefined },
    });
    const problem = checkAttachArgv(r.argv);
    if (problem) throw new UsageError(problem);
    return r.argv;
  };
  const attach = async (boxId: string, kind: "session" | "side" | "shell", platform?: string) => {
    state.code = await exec(await attachArgv(boxId, kind, platform));
  };

  box
    .command("open")
    .description("Start a box when it's stopped, then attach to its session.")
    .argument("<boxId>")
    .option("--force", "Start it even when its container runs with stale mounts.")
    .action(async (boxId: string, o: { force?: boolean }) => {
      const c = client();
      const v = await c.call("boxes.get", { params: { boxId } });
      if (v.status === "stopped") {
        // Check the attach command first, so a refused one doesn't leave
        // behind a box this command started. The start can change the
        // container, so the command is fetched and checked again after it.
        await attachArgv(boxId, "session");
        await c.call("boxes.start", { params: { boxId }, body: { force: o.force ?? false } });
      }
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
          ["Container", r.container ? containerCell(r.container) : null],
          ["Stale", r.container?.stale?.join(", ")],
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
      for (const [set, clear, setFlag, clearFlag] of [
        [o.primaryRepo, o.clearPrimaryRepo, "--primary-repo", "--clear-primary-repo"],
        [o.tcpMap, o.clearTcpMaps, "--tcp-map", "--clear-tcp-maps"],
        [o.mount, o.clearMounts, "--mount", "--clear-mounts"],
      ] as const) {
        if (set !== undefined && clear) {
          throw new UsageError(`Use ${setFlag} or ${clearFlag}, not both.`);
        }
      }
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

  project
    .command("remove")
    .description(
      "Delete a project's record. Never deletes the folder, worktrees, or transcripts. Refused when the project has boxes.",
    )
    .argument("<projectId>")
    .option("--force", "Also remove the project's box records. The boxes must be stopped.")
    .action(async (projectId: string, o: { force?: boolean }) => {
      const r = await client().call("projects.remove", {
        params: { projectId },
        query: { force: o.force ? "true" : "false" },
      });
      print(
        r,
        () =>
          `Removed the project ${projectId}.${
            r.boxes.length > 0 ? ` Removed the box records: ${r.boxes.join(", ")}.` : ""
          } The folder and the transcripts are untouched.\n`,
      );
    });

  project
    .command("restart")
    .description("Restart the project's container and every box that was running in it.")
    .argument("<projectId>")
    .action(async (projectId: string) => {
      const r = await client().call("projects.restartContainer", { params: { projectId } });
      if (r.failed.length > 0) state.code = 1;
      print(
        r,
        () =>
          [
            `Restarted the container of ${projectId}.`,
            ...(r.done.length > 0 ? [`Started again: ${r.done.join(", ")}.`] : []),
            ...r.failed.map((f) => `Failed ${f.boxId}: ${f.error.message}`),
          ].join("\n") + "\n",
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
      if (isReadOnlyPostPush({ readOnly: o.readOnly ?? false, pipeline: o.pipeline })) {
        throw new UsageError(READ_ONLY_POST_PUSH_MESSAGE);
      }
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
  // secrets
  const secrets = program.command("secrets").description("Work with 1Password secrets.");

  secrets
    .command("available")
    .description("List the 1Password fields a project can reference. Never shows values.")
    .option("--refresh", "Skip the server's 30 second cache.")
    .action(async (o: { refresh?: boolean }) => {
      const r = await client().call("secrets.available", {
        query: { refresh: o.refresh ? "true" : "false" },
      });
      print(r, () => {
        const rows = r.candidates.map((c) => [c.suggestedName, c.ref, c.type]);
        const errors = r.vaultErrors.map((e) => `${e.vault}: ${e.message}\n`).join("");
        return `${table(["NAME", "REFERENCE", "TYPE"], rows)}${errors}`;
      });
    });

  // -------------------------------------------------------------------------
  // accounts
  const accounts = program
    .command("accounts")
    .description("List, add, and seed the agent CLI accounts.");

  const accountParams = (id: string) => {
    const parsed = parseAccountId(id);
    if (!parsed)
      throw new UsageError(`Invalid account ${id}; use VENDOR/NAME, such as claude/work.`);
    return parsed;
  };

  accounts
    .command("list")
    .description("List the accounts of every vendor.")
    .action(async () => {
      const r = await client().call("accounts.list");
      print(r, () => accountRows(r.accounts));
    });

  accounts
    .command("add")
    .description("Create an account with an empty folder; sign in to it from a box.")
    .argument("<vendor>", `One of ${PLATFORMS.join(", ")}.`, choice(PLATFORMS))
    .argument("<name>", "Lowercase letters, digits, and hyphens, such as work.")
    .option("--label <text>", "A display name. Default: the name.")
    .action(async (vendor: string, name: string, o: { label?: string }) => {
      const r = await client().call("accounts.create", {
        body: { vendor: vendor as "claude", name, label: o.label },
      });
      print(r, () => `Created ${r.account.id} in ${r.dir}${r.isDefault ? " (default)" : ""}.\n`);
    });

  accounts
    .command("mode")
    .description("Show or set where boxes get their agent folders: host or accounts.")
    .argument("[mode]", "host or accounts. Omit it to show the current mode.")
    .action(async (mode: string | undefined) => {
      const c = client();
      if (mode !== undefined && mode !== "host" && mode !== "accounts") {
        throw new UsageError("Use host or accounts.");
      }
      const settings =
        mode === undefined
          ? await c.call("settings.get")
          : await c.call("settings.patch", { body: { accountsMode: mode } });
      print(
        { accountsMode: settings.accountsMode },
        () =>
          `Boxes use ${settings.accountsMode === "accounts" ? "account folders" : "the host's agent folders"} (${settings.accountsMode}).${
            mode === undefined ? "" : " Restart each project container for it to take effect."
          }\n`,
      );
    });

  accounts
    .command("login")
    .description("Print the command that signs an account in; run it in a box shell.")
    .argument("<id>", "The account, VENDOR/NAME.")
    .action(async (id: string) => {
      const params = accountParams(id);
      const r = await client().call("accounts.get", { params });
      const env = `${ACCOUNT_DIR_ENV[r.account.vendor]}=${r.dir}`;
      const command = `${env} ${ACCOUNT_SIGN_IN_COMMAND[r.account.vendor].join(" ")}`;
      print({ command }, () => `${command}\n`);
    });

  accounts
    .command("import")
    .description(
      "Install a ready, signed-in config folder as an account. Moves the folder unless you pass --copy.",
    )
    .argument("<vendor>", `One of ${PLATFORMS.join(", ")}.`, choice(PLATFORMS))
    .argument("<name>", "Lowercase letters, digits, and hyphens, such as work.")
    .requiredOption("--from <dir>", "The vendor's config folder, such as a CLAUDE_CONFIG_DIR.")
    .option("--copy", "Copy the folder and keep the original. A Claude refresh token rotates.")
    .option("--label <text>", "A display name. Default: the name.")
    .action(
      async (vendor: string, name: string, o: { from: string; copy?: boolean; label?: string }) => {
        const r = await client().call("accounts.import", {
          body: {
            vendor: vendor as "claude",
            name,
            from: absolute(o.from),
            copy: o.copy ?? false,
            label: o.label,
          },
        });
        print(r, () => {
          const lines = [
            `${r.mode === "moved" ? "Moved" : "Copied"} the folder to ${r.dir} as ${r.account.id}${r.isDefault ? " (default)" : ""}.`,
            ...r.warnings.map((w) => `Warning: ${w}`),
            `Run "aio accounts check ${r.account.id}" to confirm it is signed in.`,
          ];
          return `${lines.join("\n")}\n`;
        });
      },
    );

  accounts
    .command("set")
    .description("Change an account, or make it its vendor's default.")
    .argument("<id>", "The account, VENDOR/NAME.")
    .option("--label <text>", "A display name.")
    .addOption(
      new Option("--overflow <state>", "Whether runs can overflow to this account.").choices([
        "on",
        "off",
      ]),
    )
    .option("--default", "Make it its vendor's default account.")
    .action(async (id: string, o: { label?: string; overflow?: string; default?: boolean }) => {
      const params = accountParams(id);
      const c = client();
      if (o.label === undefined && o.overflow === undefined && !o.default) {
        throw new UsageError("Name something to change: --label, --overflow, or --default.");
      }
      let view =
        o.label !== undefined || o.overflow !== undefined
          ? await c.call("accounts.update", {
              params,
              body: {
                ...(o.label !== undefined ? { label: o.label } : {}),
                ...(o.overflow !== undefined ? { overflow: o.overflow === "on" } : {}),
              },
            })
          : null;
      if (o.default) {
        await c.call("settings.patch", { body: { accountDefaults: { [params.vendor]: id } } });
        view = await c.call("accounts.get", { params });
      }
      print(view, () => `Updated ${id}.\n`);
    });

  accounts
    .command("remove")
    .description("Delete an account record. Its folder stays on disk.")
    .argument("<id>", "The account, VENDOR/NAME.")
    .action(async (id: string) => {
      const r = await client().call("accounts.remove", { params: accountParams(id) });
      print(r, () => `Removed ${id}. Its folder stays at ${r.keptDir}.\n`);
    });

  accounts
    .command("check")
    .description("Ask the vendor CLI whether an account is signed in.")
    .argument("<id>", "The account, VENDOR/NAME.")
    .action(async (id: string) => {
      const r = await client().call("accounts.check", { params: accountParams(id) });
      print(
        r,
        () =>
          `${id}: ${signInText(r.account.signIn)}.\n${(r.warnings ?? []).map((w) => `Warning: ${w}\n`).join("")}`,
      );
    });

  accounts
    .command("relink")
    .description(
      "Point every Claude account's projects folder at the shared transcript store, replacing a link that dangles or leads elsewhere.",
    )
    .action(async () => {
      const r = await client().call("accounts.relink");
      print(
        r,
        () =>
          `Transcript store: ${r.store} (${r.source}).\n${r.accounts
            .map((a) => {
              const local = Object.entries(a.config.entries)
                .filter(([, o]) => o === "local")
                .map(([n]) => n);
              const linked = Object.entries(a.config.entries)
                .filter(([, o]) => o === "linked" || o === "replaced-identical")
                .map(([n]) => n);
              return (
                `${a.id}: ${a.before} -> ${a.outcome}.\n` +
                (linked.length > 0 ? `  Linked to the host: ${linked.join(", ")}.\n` : "") +
                (local.length > 0
                  ? `  Local overrides, left alone: ${local.join(", ")}. Move one away and run relink again to use the host's.\n`
                  : "")
              );
            })
            .join("")}`,
      );
    });

  program
    .command("transcripts")
    .description("Manage the Claude transcript store, DATA_DIR/transcripts/claude.")
    .command("adopt")
    .description(
      "Move the host's ~/.claude/projects transcripts into the store and point ~/.claude/projects at it. Run it when no box runs.",
    )
    .option("--dry-run", "Show what would change and change nothing.")
    .action(async (opts: { dryRun?: boolean }) => {
      const r = await client().call("transcripts.adopt", {
        body: { dryRun: opts.dryRun === true },
      });
      print(
        r,
        () =>
          `Transcript store: ${r.store}.\n${r.actions.map((a) => `${a}\n`).join("")}${r.clashes
            .map((c) => `Clash: ${c}\n`)
            .join(
              "",
            )}${r.status}: ${r.moved} file(s) moved, ${r.duplicates} already in the store${r.dryRun ? " (dry run)" : ""}.\n`,
      );
      if (r.status === "blocked") state.code = 1;
    });

  accounts
    .command("seed")
    .description(
      "Copy the host's ~/.claude, ~/.codex, and ~/.copilot into new accounts, without their sign-ins.",
    )
    .addOption(
      new Option(
        "--vendor <vendor>",
        `Seed only this vendor (repeatable): ${PLATFORMS.join(", ")}.`,
      ).argParser((value: string, previous: string[] = []) => {
        if (!PLATFORMS.includes(value)) {
          throw new InvalidArgumentError(`Use one of: ${PLATFORMS.join(", ")}.`);
        }
        return [...previous, value];
      }),
    )
    .option("--name <name>", "The name of each new account.", DEFAULT_SEED_ACCOUNT_NAME)
    .option("--dry-run", "Report what seeding would copy, and copy nothing.")
    .option("--no-wait", "Print the job and return without waiting for it.")
    .action(async (o: { vendor?: string[]; name: string; dryRun?: boolean; wait: boolean }) => {
      const c = client();
      const started: Job = await c.call("accounts.seed", {
        body: {
          ...(o.vendor ? { vendors: o.vendor as "claude"[] } : {}),
          name: o.name,
          dryRun: o.dryRun ?? false,
        },
      });
      const job = await waitForJob(c, started, o.wait);
      if (job.status === "failed") {
        state.code = 1;
        deps.err(
          terminalText(`Seeding failed: ${job.error?.message ?? `exit code ${job.exitCode}`}\n`),
        );
        if (globals().json) deps.out(`${jsonText(job, 2)}\n`);
        return;
      }
      if (job.status === "running") {
        print(job, () => `Seeding accounts (job ${job.id}).\n`);
        return;
      }
      const parsed = AccountSeedReportSchema.safeParse(job.result);
      if (!parsed.success) {
        state.code = 1;
        deps.err("The seed job's result doesn't match the contract.\n");
        if (globals().json) deps.out(`${jsonText(job, 2)}\n`);
        return;
      }
      const report = parsed.data;
      print(report, () => seedText(report));
    });

  // -------------------------------------------------------------------------
  // migrate, setup, doctor, events
  program
    .command("migrate")
    .description("Import the 3.x records under ~/.ai-orchestrator into the server's database.")
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
    .description(
      "Check the server, the token, Docker, the image, the engines, and sudo in containers.",
    )
    .action(async () => {
      // A refused URL is a failed check here, not a usage error: doctor
      // reports what's wrong rather than stopping at the first problem.
      const s = unchecked();
      const refused = urlProblem(s);
      type Row = { check: string; status: "ok" | "warn" | "fail"; detail: string };
      const rows: Row[] = [];
      const add = (check: string, status: Row["status"], detail: string) =>
        rows.push({ check, status, detail });
      const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

      let c: ServerClient | null = null;
      let reachable = false;
      if (refused) {
        add("server", "fail", refused);
      } else {
        c = clientFor(s);
        try {
          const h = await c.call("health");
          reachable = true;
          add("server", "ok", `${displayUrl(s.baseUrl)}, version ${h.version}`);
        } catch (e) {
          add("server", "fail", describe(e));
        }
      }
      if (c && reachable) {
        if (s.token === null) {
          add("token", "fail", `No token in AIO_TOKEN or ${s.tokenFile}.`);
        } else {
          try {
            const setup = await c.call("setup.get");
            add("token", "ok", s.tokenSource === "file" ? s.tokenFile : "AIO_TOKEN");
            for (const id of ["docker", "image", "engine", "sudo"] as const) {
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
        throw new ApiCallError(401, "unauthorized", `No token in AIO_TOKEN or ${s.tokenFile}.`);
      await tailEvents({
        baseUrl: s.baseUrl,
        token: s.token,
        types: o.types,
        count: o.count,
        write: deps.out,
        warn: deps.err,
        WebSocket: deps.WebSocket,
        tls: serverTls(s),
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
    if (err instanceof UsageError || err instanceof RequestInputError) {
      deps.err(terminalText(`${err.message}\n`));
      return 2;
    }
    if (err instanceof InterruptedError) {
      deps.err(`${err.message}\n`);
      return 130;
    }
    if (err instanceof ApiCallError) {
      deps.err(terminalText(`Error (${err.code}): ${err.message}\n`));
      if (err.details !== undefined && program.opts().json) {
        deps.err(`${jsonText(err.details, 2)}\n`);
      }
      return 1;
    }
    if (err instanceof ServerUnreachableError) {
      deps.err(terminalText(`${err.message}\n`));
      if (err.suggestStart) deps.err("Start it with: systemctl --user start aio-server\n");
      return 1;
    }
    deps.err(terminalText(`${err instanceof Error ? err.message : String(err)}\n`));
    return 1;
  }
}
