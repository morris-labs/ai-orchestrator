// The `aio` command tree.
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import {
  ACCOUNT_DIR_ENV,
  ACCOUNT_SIGN_IN_COMMAND,
  AccountSeedReportSchema,
  DEFAULT_SEED_ACCOUNT_NAME,
  DecisionOptionSchema,
  EffortSchema,
  LOCAL_MACHINE_ID,
  RUN_CONCURRENCY_CAPABILITY,
  PlatformSchema,
  ProfileSchema,
  READ_ONLY_POST_PUSH_MESSAGE,
  WHOLE_POST_PUSH_MESSAGE,
  isWholePostPush,
  RoleSchema,
  SeveritySchema,
  VerdictSchema,
  hostToContainer,
  isReadOnlyPostPush,
  parseAccountId,
  type AccountSeedReport,
  VendorSchema,
  UpgradePreviewSchema,
  type AccountSignIn,
  runDepth,
  type AccountView,
  type BoxView,
  type Ceiling,
  type ContainerInfo,
  type Finding,
  type HostOs,
  type Job,
  type Machine,
  type NodeStatus,
  type ProjectSummary,
  type Role,
  type RoleOverrides,
  type RunState,
  type SetupCheck,
  type Vendor,
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
import { fleetRunText, listFleetRuns } from "./fleet.js";
import { jsonText, keyValues, percent, table, terminalText } from "./format.js";
import { attachRemote, readSecretLine, type TerminalIo } from "./terminal.js";
import {
  checkAttachArgv,
  checkServerUrl,
  displayUrl,
  dataDirFor,
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
  exec?: (argv: string[], options?: { env: NodeJS.ProcessEnv }) => Promise<number>;
  WebSocket?: WebSocketCtor;
  /**
   * The terminal that `box attach MACHINE/BOX` attaches and that `node join`
   * reads its code from. Default: standard input and output.
   */
  terminal?: TerminalIo;
  /** How often `box new` and `accounts seed` poll their job. */
  pollMs?: number;
  /**
   * Stops the running command: `events` ends cleanly, and any other command
   * stops its request or job polling and exits 130. Ctrl+C by default.
   */
  signal?: AbortSignal;
  /** The directory relative paths resolve against; the process's own by default. */
  cwd?: string;
  /**
   * The host OS, which decides how a host path maps to the path a box's
   * container sees. Default `linux`; `main.ts` passes the real one.
   */
  hostOs?: HostOs;
}

/** A usage problem the CLI reports with exit code 2. */
export class UsageError extends Error {}

const BOX_TARGET_HELP =
  "The box ID, or MACHINE/BOX for a box on another machine, where MACHINE is a machine ID or name from aio machines list.";

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

const WINDOW_ORDER: readonly string[] = ["5h", "7d", "month"];

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * Turns repeated `--role ROLE=VENDOR[,VENDOR]` options into the `roles`
 * body field. Only `reviewer` takes more than one vendor.
 */
function rolesOf(specs: readonly string[]): RoleOverrides | undefined {
  const out: RoleOverrides = {};
  for (const spec of specs) {
    const [role = "", list = "", ...rest] = spec.split("=");
    const vendors = list.split(",");
    if (rest.length > 0 || !ROLES.includes(role) || vendors.some((v) => v === "")) {
      throw new UsageError(
        `Invalid role ${spec}; use ROLE=VENDOR[,VENDOR], with a role of ${ROLES.join(", ")}.`,
      );
    }
    const unknown = vendors.filter((v) => !PLATFORMS.includes(v));
    if (unknown.length > 0) {
      throw new UsageError(`Unknown vendor ${unknown.join(", ")}; use ${PLATFORMS.join(", ")}.`);
    }
    if (role in out) throw new UsageError(`The ${role} role is given twice.`);
    if (role === "reviewer") out.reviewer = vendors as Vendor[];
    else if (vendors.length > 1) throw new UsageError(`The ${role} role takes one vendor.`);
    else out[role as Exclude<Role, "reviewer">] = vendors[0] as Vendor;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
 * and a missing container path is the resolved host path's container path:
 * the host path itself, except on Windows, where the colon of a drive
 * letter also belongs to the host path.
 */
function parseMount(
  spec: string,
  cwd: string,
  hostOs: HostOs = "linux",
  remote?: string,
): { host: string; container: string } {
  const from = hostOs === "win32" && /^[A-Za-z]:/.test(spec) ? 2 : 0;
  const i = spec.indexOf(":", from);
  const host = i < 0 ? spec : spec.slice(0, i);
  const container = i < 0 ? spec : spec.slice(i + 1);
  if (host === "" || container === "")
    throw new UsageError(`Invalid mount ${spec}; use HOST[:CONTAINER].`);
  if (remote !== undefined && !isAbsoluteOn(host, hostOs)) throw relativeOnRemote(host, remote);
  const resolved = hostOs === "win32" ? path.win32.resolve(cwd, host) : path.resolve(cwd, host);
  if (i >= 0) return { host: resolved, container };
  try {
    return {
      host: resolved,
      container: hostOs === "win32" ? hostToContainer(resolved, hostOs) : resolved,
    };
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

/** True when `p` is an absolute path on a host that runs `hostOs`. */
function isAbsoluteOn(p: string, hostOs: HostOs): boolean {
  return hostOs === "win32" ? /^[A-Za-z]:[\\/]/.test(p) : p.startsWith("/");
}

/** The error for a relative path given for another machine, `machine`. */
function relativeOnRemote(p: string, machine: string): UsageError {
  return new UsageError(
    `${p} is a relative path. A path on ${machine} doesn't resolve against this directory, so give the absolute path on ${machine}.`,
  );
}

/** The error for a relative `--repo` given for another machine, `machine`. */
function remoteRepoMessage(machine: string): string {
  return `With --machine, give --repo as an absolute path on ${machine}, or give --box.`;
}

/** The machine a command goes to when it isn't this server's own. */
interface MachineTarget {
  id: string;
  name: string;
  /** The machine's host OS, which decides how its paths look; `null` when unknown. */
  platform: HostOs | null;
  /** The link capabilities the machine's server lists. */
  capabilities: string[];
  /** The machine's link status; capabilities are only current when it is `online`. */
  status: Machine["status"];
}

/** One machine's part of `aio box list --all-machines`. */
interface FleetPart {
  id: string;
  name: string;
  isLocal: boolean;
  status: Machine["status"];
  /** The machine's boxes, or `null` when it is offline or its call failed. */
  boxes: BoxView[] | null;
  error: { code: string; message: string } | null;
}

/** A box ID as fleet views show it: `MACHINE/BOX` for another machine's box. */
function fleetBoxId(part: FleetPart, boxId: string): string {
  return part.isLocal ? boxId : `${part.name}/${boxId}`;
}

function fleetRows(parts: FleetPart[]) {
  return table(
    ["MACHINE", "BOX", "STATUS", "REVIEW", "PLATFORM", "CONVERSATION", "PROJECT"],
    parts.flatMap((part) =>
      (part.boxes ?? []).map((b) => [
        part.name,
        fleetBoxId(part, b.box.id),
        b.status,
        b.reviewState.state === "under_review" ? `run ${b.reviewState.runId}` : "",
        b.box.platform,
        b.box.conversationName,
        b.box.projectId,
      ]),
    ),
  );
}

/** True when an error means the server has no machine routes, as an older server doesn't. */
function noMachineRoutes(err: unknown): boolean {
  return err instanceof ApiCallError && [404, 405, 501].includes(err.status);
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
    [
      "Range",
      r.request.scope === "whole"
        ? `whole project at ${r.request.tip ?? "HEAD"}`
        : `${r.request.base}${r.request.mergeBase ? "..." : ".."}${r.request.tip ?? "HEAD"}`,
    ],
    ["Excludes", r.request.excludePaths?.join(", ")],
    ["Model tier", r.request.modelTier],
    ["Depth", runDepth(r.request)],
    ["Reviewer effort", r.request.reviewerEffort],
    ["Parallel calls", r.request.concurrency],
    ["Verification floor", r.request.verifyFloor],
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
    ...(r.rootCauses?.causes ?? []).map((c): [string, string] => [
      `Root cause ${c.fixOrder}`,
      `${c.title} (${c.findingIds.join(", ")})`,
    ]),
  ]);
}

function findingRows(findings: Finding[]) {
  return table(
    ["ID", "SEV", "VERDICT", "ROUND", "LOCATION", "TITLE"],
    findings.map((f) => [
      f.id,
      f.severity,
      f.followUpReason
        ? `${f.verdict} (needs follow-up)`
        : f.unverifiedReason
          ? `${f.verdict} (not verified: below floor)`
          : f.fixHeldReason
            ? `${f.verdict} (not sent to the fixer: below floor)`
            : f.floorBypassReason
              ? `${f.verdict} (triage: sent to the fixer)`
              : f.verdict,
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

function defaultExec(argv: string[], options?: { env: NodeJS.ProcessEnv }): Promise<number> {
  return new Promise((resolve, reject) => {
    const [program, ...args] = argv as [string, ...string[]];
    const child = spawn(program, args, { stdio: "inherit", env: options?.env ?? childEnv() });
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
    .option(
      "--machine <machine>",
      "Send the command to another machine of a multi-host setup, by its ID or name from aio machines list. The server relays it through the hub. Default: this machine.",
    )
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: deps.out, writeErr: deps.err });

  const globals = () =>
    program.opts<{
      json?: boolean;
      server?: string;
      insecure?: boolean;
      dataDir?: string;
      machine?: string;
    }>();
  // The server resolves nothing against its own working directory, so every
  // path leaves the CLI absolute.
  const cwd = deps.cwd ?? process.cwd();
  // `path.win32` is what `path` is on Windows; naming it keeps an injected
  // `hostOs` testable on any host.
  const absolute = (p: string) =>
    deps.hostOs === "win32" ? path.win32.resolve(cwd, p) : path.resolve(cwd, p);
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
  /**
   * A client for `s`, which must have passed `urlProblem()`. Its calls go to
   * `machine`: by default the machine the command names, if any.
   */
  const clientFor = (
    s: CliSettings,
    machine: () => Promise<string | null> = async () => (await target())?.id ?? null,
    signal: AbortSignal | undefined = deps.signal,
  ) =>
    new ServerClient({
      baseUrl: s.baseUrl,
      token: s.token,
      fetch: deps.fetch ?? serverFetch(s),
      signal,
      machine,
    });
  const client = () => clientFor(settings());
  const thisServer = async () => null;

  // A command names another machine with `--machine`, or with a box argument
  // of the form `MACHINE/BOX`, as fleet views show it.
  let namedByBox: string | undefined;
  let resolved: Promise<MachineTarget | null> | null = null;
  /** The machine the command goes to, or `null` for this server. Resolved once. */
  const target = () => (resolved ??= resolveTarget());
  const resolveTarget = async (): Promise<MachineTarget | null> => {
    const want = namedByBox ?? globals().machine;
    if (want === undefined || want === LOCAL_MACHINE_ID) return null;
    let machines: Machine[];
    try {
      machines = (await clientFor(settings(), thisServer).call("machines.list")).machines;
    } catch (err) {
      if (noMachineRoutes(err)) {
        throw new UsageError(
          `The server has no machine routes, so it can't reach ${want}. Only ${LOCAL_MACHINE_ID} names a machine there.`,
        );
      }
      throw err;
    }
    // A revoked machine's name is free to enroll again, so the name means the
    // live machine when there is one, and an older revoked row can't shadow it.
    const m =
      machines.find((x) => x.id === want) ??
      machines.find((x) => x.name === want && x.status !== "revoked") ??
      machines.find((x) => x.name === want);
    if (!m) {
      throw new UsageError(
        `No machine has the ID or name ${want}. List the machines with: aio machines list`,
      );
    }
    return m.isLocal
      ? null
      : {
          id: m.id,
          name: m.name,
          platform: m.platform,
          capabilities: m.capabilities,
          status: m.status,
        };
  };
  /**
   * The link capabilities this machine's own server lists. A server with no
   * machine routes predates every capability, so it lists none.
   */
  const localCapabilities = async (): Promise<string[]> => {
    let machines: Machine[];
    try {
      machines = (await clientFor(settings(), thisServer).call("machines.list")).machines;
    } catch (err) {
      if (noMachineRoutes(err)) return [];
      throw err;
    }
    return machines.find((m) => m.isLocal)?.capabilities ?? [];
  };
  /**
   * Reads a box argument, `BOX` or `MACHINE/BOX`, and returns the box ID.
   * Call it before the command's first request, so the machine applies.
   */
  const boxRef = (raw: string): string => {
    const i = raw.indexOf("/");
    if (i < 0) return raw;
    const machine = raw.slice(0, i);
    const boxId = raw.slice(i + 1);
    if (machine === "" || boxId === "" || boxId.includes("/")) {
      throw new UsageError(`Invalid box ${raw}; use BOX or MACHINE/BOX.`);
    }
    const flag = globals().machine;
    if (flag !== undefined && flag !== machine) {
      throw new UsageError(`The box ${raw} names ${machine}, but --machine names ${flag}.`);
    }
    if (namedByBox !== undefined && namedByBox !== machine) {
      throw new UsageError(`The boxes name two machines, ${namedByBox} and ${machine}.`);
    }
    namedByBox = machine;
    return boxId;
  };
  /** The host OS of the machine the command goes to. */
  const targetOs = async (): Promise<HostOs> => {
    const t = await target();
    return t ? (t.platform ?? "linux") : (deps.hostOs ?? "linux");
  };
  /**
   * A host path for the machine the command goes to: resolved against the
   * current directory on this machine, and required to be absolute on
   * another, where this directory means nothing.
   */
  const hostPath = async (p: string): Promise<string> => {
    const t = await target();
    if (!t) return absolute(p);
    const os = t.platform ?? "linux";
    if (!isAbsoluteOn(p, os)) throw relativeOnRemote(p, t.name);
    return os === "win32" ? path.win32.normalize(p) : path.posix.normalize(p);
  };
  /** Refuses `--machine` for a command about this machine itself. */
  const thisMachineOnly = (command: Command) =>
    command.hook("preAction", () => {
      const machine = globals().machine;
      if (machine !== undefined && machine !== LOCAL_MACHINE_ID) {
        throw new UsageError(
          `aio ${command.name()} works on this machine only. Run it on ${machine} instead of passing --machine.`,
        );
      }
    });
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

  /** This server's machine list, or an empty list from a server without machine routes. */
  const machineList = async (): Promise<Machine[]> => {
    try {
      return (await clientFor(settings(), thisServer).call("machines.list")).machines;
    } catch (err) {
      if (noMachineRoutes(err)) return [];
      throw err;
    }
  };
  /** This server's machine, then every other machine that is online or offline. */
  const fleet = async (): Promise<Pick<Machine, "id" | "name" | "isLocal" | "status">[]> => {
    const machines = await machineList();
    const self = machines.find((m) => m.isLocal) ?? {
      id: LOCAL_MACHINE_ID,
      name: LOCAL_MACHINE_ID,
      isLocal: true,
      status: "online" as const,
    };
    return [
      self,
      ...machines.filter((m) => !m.isLocal && (m.status === "online" || m.status === "offline")),
    ];
  };
  /**
   * Lists the boxes of this machine and every other online one, each
   * through the machine proxy route. An offline machine lists no boxes, and
   * a machine whose call fails gets the error instead.
   */
  const listFleet = async (projectId: string | undefined): Promise<FleetPart[]> => {
    const s = settings();
    return Promise.all(
      (await fleet()).map(async (m): Promise<FleetPart> => {
        const part = { id: m.id, name: m.name, isLocal: m.isLocal, status: m.status };
        if (!m.isLocal && m.status !== "online") return { ...part, boxes: null, error: null };
        const c = clientFor(s, async () => (m.isLocal ? null : m.id));
        try {
          const r = await c.call("boxes.list", { query: { projectId } });
          return { ...part, boxes: r.boxes, error: null };
        } catch (err) {
          // This server's own list must work; another machine's failure is
          // reported with the rest of the fleet.
          if (m.isLocal || !(err instanceof ApiCallError)) throw err;
          return { ...part, boxes: null, error: { code: err.code, message: err.message } };
        }
      }),
    );
  };

  // -------------------------------------------------------------------------
  // box
  const box = program.command("box").description("Create, start, stop, and attach to boxes.");

  box
    .command("list")
    .description("List boxes.")
    .option("--project <id>", "Only boxes in this project.")
    .option(
      "--all-machines",
      "List the boxes of every machine of a multi-host setup. Another machine's box IDs have the form MACHINE/BOX.",
    )
    .action(async (o: { project?: string; allMachines?: boolean }) => {
      if (!o.allMachines) {
        const r = await client().call("boxes.list", { query: { projectId: o.project } });
        print(r, () => boxRows(r.boxes));
        return;
      }
      if (globals().machine !== undefined) {
        throw new UsageError("Use --all-machines or --machine, not both.");
      }
      const parts = await listFleet(o.project);
      for (const p of parts) {
        if (p.error) state.code = 1;
        if (p.boxes === null) {
          deps.err(
            terminalText(
              `Warning: no boxes from ${p.name}: ${p.error ? p.error.message : `it is ${p.status}.`}\n`,
            ),
          );
        }
      }
      print({ machines: parts }, () => fleetRows(parts));
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
      const fork = o.fork === undefined ? undefined : boxRef(o.fork as string);
      const targetDir = await hostPath(dir);
      const c = client();
      const conversation = o.adopt
        ? { mode: "adopt" as const, sessionUuid: o.adopt as string }
        : fork
          ? { mode: "fork" as const, fromBoxId: fork }
          : { mode: "new" as const };
      const created: Job = await c.call("boxes.create", {
        body: {
          targetDir,
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
    .action(async (ref: string, o: { force?: boolean }) => {
      const boxId = boxRef(ref);
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
      .action(async (ref: string) => {
        const v = await client().call(key, { params: { boxId: boxRef(ref) } });
        print(v, () => `${v.box.id} is ${v.status}.\n`);
      });
  }

  box
    .command("account")
    .description("Set a box's account for a vendor, or use the default again with a bare vendor.")
    .argument("<boxId>")
    .argument("<account>", "VENDOR/NAME to set; VENDOR alone to use the default again.")
    .action(async (ref: string, account: string) => {
      const boxId = boxRef(ref);
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
    .action(async (ref: string, o: { removeWorktree?: boolean }) => {
      const boxId = boxRef(ref);
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
    .action(async (ref: string, o: { yes?: boolean; dryRun?: boolean }) => {
      const boxId = boxRef(ref);
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
  /**
   * Attaches to a box on the machine the command goes to. Call `boxRef`
   * first, so a `MACHINE/BOX` argument picks the machine.
   */
  const attach = async (boxId: string, kind: "session" | "side" | "shell", platform?: string) => {
    const remote = await target();
    if (!remote) {
      state.code = await exec(await attachArgv(boxId, kind, platform));
      return;
    }
    const machineId = remote.id;
    // A box on another machine: a host terminal here can't reach its
    // container, so the terminal goes through the server and the hub.
    const s = settings();
    if (s.token === null)
      throw new ApiCallError(401, "unauthorized", `No token in AIO_TOKEN or ${s.tokenFile}.`);
    state.code = await attachRemote({
      baseUrl: s.baseUrl,
      token: s.token,
      machineId,
      boxId,
      kind,
      ...(platform ? { platform: platform as "claude" } : {}),
      io: deps.terminal ?? { input: process.stdin, output: process.stdout },
      note: deps.err,
      WebSocket: deps.WebSocket,
      tls: serverTls(s),
    });
  };

  box
    .command("open")
    .description("Start a box when it's stopped, then attach to its session.")
    .argument("<boxId>")
    .option("--force", "Start it even when its container runs with stale mounts.")
    .action(async (ref: string, o: { force?: boolean }) => {
      const boxId = boxRef(ref);
      if (await target()) {
        throw new UsageError(
          "aio box open works on this machine's boxes. To attach to a running box on another machine, run aio box attach MACHINE/BOX.",
        );
      }
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
    .description(
      "Attach this terminal to a box's session. For a box on another machine, press Ctrl+] twice to detach.",
    )
    .argument("<boxId>", BOX_TARGET_HELP)
    .addOption(
      new Option("--side <platform>", "Attach to a side session instead.").choices(PLATFORMS),
    )
    .action(async (ref: string, o: { side?: string }) => {
      await attach(boxRef(ref), o.side ? "side" : "session", o.side);
    });

  box
    .command("shell")
    .description("Open a shell in the box's container.")
    .argument("<boxId>", BOX_TARGET_HELP)
    .action(async (ref: string) => {
      await attach(boxRef(ref), "shell");
    });

  box
    .command("message")
    .description("Send one message to the box's interactive session.")
    .argument("<boxId>")
    .argument("<text...>")
    .action(async (ref: string, text: string[]) => {
      const r = await client().call("boxes.message", {
        params: { boxId: boxRef(ref) },
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
      if (o.primaryRepo !== undefined) body.primaryRepo = await hostPath(o.primaryRepo as string);
      if (o.clearPrimaryRepo) body.primaryRepo = null;
      if (o.policyPath !== undefined) body.policyPath = o.policyPath;
      if (o.tcpMap) body.tcpMaps = (o.tcpMap as string[]).map(parsePortPair);
      if (o.clearTcpMaps) body.tcpMaps = [];
      if (o.mount) {
        const t = await target();
        const os = await targetOs();
        body.mounts = (o.mount as string[]).map((m) => parseMount(m, cwd, os, t?.name));
      }
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
      "The repository, relative to the current directory; implied by --box. On Windows, give the host path or the container path under /mnt/host. With --machine, give the absolute path on that machine.",
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
    .option(
      "--role <role=vendors>",
      "Give a role to vendors from round 1 over the profile's default, such as reviewer=codex,copilot (repeatable).",
      collect,
      [],
    )
    .addOption(
      new Option(
        "--tier <tier>",
        "Use auto, which picks a model tier per group and role, or a tier for the run. With small, code, disprovers, confirmers, and fixers still use medium.",
      )
        .choices(["auto", "small", "medium", "large"])
        .default("auto"),
    )
    .addOption(
      new Option(
        "--depth <depth>",
        "Use standard for P1 and P2 findings, one reviewer pass per group, batched verification, and at most 2 rounds, or thorough for every severity, per-finding verification, and at most 25 rounds.",
      )
        .choices(["standard", "thorough"])
        .default("standard"),
    )
    .option(
      "--concurrency <n>",
      "Set how many review calls run at once on each vendor, and how many verification calls run at once, from 1 to 20. Default: 6 and 4.",
      (v: string) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 20)
          throw new InvalidArgumentError("Give a whole number from 1 to 20.");
        return n;
      },
    )
    .addOption(
      new Option(
        "--reviewer-effort <effort>",
        "Set the reasoning effort for reviewer calls on Claude and Codex. Default: each vendor's own default.",
      ).choices(["low", "medium", "high", "xhigh", "max"]),
    )
    .addOption(
      new Option(
        "--verify-floor <severity>",
        "Send only findings at or above this severity to a disprover. The rest stay pending, unchecked, and away from the fixer. Use all to check every severity. Default: P2 with --depth standard, and every severity with --depth thorough.",
      ).choices([...SEVERITIES, "all"]),
    )
    .option(
      "--whole-project",
      "Review the project at the tip instead of a range. The base and --exact-base don't apply.",
    )
    .option("--exclude <glob...>", "Never group or review the files that match these globs.")
    .option("--no-cross-vendor", "Let the same vendor disprove and confirm its own work.")
    .option(
      "--root-causes",
      "End the run with one cheap call that groups confirmed findings by root cause and suggests a fix order.",
    )
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
      const boxId = o.box === undefined ? undefined : boxRef(o.box as string);
      const scope = o.wholeProject ? ("whole" as const) : undefined;
      if (isWholePostPush({ scope, pipeline: o.pipeline })) {
        throw new UsageError(WHOLE_POST_PUSH_MESSAGE);
      }
      const roles = rolesOf(o.role);
      const c = client();
      const remote = await target();
      let projectId: string | undefined = o.project;
      const hostOs = await targetOs();
      // The engine runs in the container, so it gets the container path:
      // the same as the host path except on Windows.
      const toContainer = (p: string, os: HostOs = hostOs) => {
        try {
          return hostToContainer(p, os);
        } catch (err) {
          throw new UsageError((err as Error).message);
        }
      };
      const repoArg = o.repo as string | undefined;
      let repoPath: string | undefined;
      if (repoArg === undefined) {
        repoPath = undefined;
      } else if (remote) {
        // Another machine's path can't resolve against this directory. A
        // machine that reports no platform gets it from the path's form.
        const os = remote.platform ?? (isAbsoluteOn(repoArg, "win32") ? "win32" : "linux");
        if (os === "win32" && repoArg.startsWith("/")) repoPath = repoArg;
        else if (isAbsoluteOn(repoArg, os))
          repoPath = toContainer(
            os === "win32" ? path.win32.normalize(repoArg) : path.posix.normalize(repoArg),
            os,
          );
        else throw new UsageError(remoteRepoMessage(remote.name));
      } else {
        // On Windows a POSIX path is already a container path.
        repoPath =
          hostOs === "win32" && repoArg.startsWith("/")
            ? repoArg
            : toContainer(await hostPath(repoArg));
      }
      let tip: string | undefined = o.tip;
      if (boxId) {
        const v = await c.call("boxes.get", { params: { boxId } });
        projectId ??= v.box.projectId;
        repoPath ??= v.containerWorkDir ?? toContainer(v.box.worktree ?? v.box.targetDir);
        tip ??= v.box.branch;
      }
      if (!projectId || !repoPath) {
        throw new UsageError("Give --box, or both --project and --repo.");
      }
      // An older server drops `concurrency` and runs at its defaults, so
      // refuse the flag rather than start a run that ignores it. This
      // covers this machine's own server too, which might predate the CLI.
      if (o.concurrency !== undefined) {
        // A machine that isn't online might list no capabilities only because
        // nothing has reached it, so say so rather than call its server old.
        if (remote && remote.status !== "online") {
          throw new UsageError(
            `${remote.name} is ${remote.status}, so aio can't check that its server can set --concurrency. Try again when ${remote.name} is online.`,
          );
        }
        const capabilities = remote ? remote.capabilities : await localCapabilities();
        if (!capabilities.includes(RUN_CONCURRENCY_CAPABILITY)) {
          throw new UsageError(
            remote
              ? `The server on ${remote.name} is too old to set --concurrency. Leave out --concurrency, or update that machine's server.`
              : "This machine's server is too old to set --concurrency. Leave out --concurrency, or restart the aio-server unit to load the updated server.",
          );
        }
      }
      const run = await c.call("runs.create", {
        body: {
          projectId,
          boxId,
          repoPath,
          base: o.base,
          tip,
          exactBase: o.exactBase ?? false,
          readOnly: o.readOnly ?? false,
          includeWorktree: o.includeWorktree ?? false,
          profile: o.profile,
          roles,
          modelTier: o.tier,
          depth: o.depth,
          reviewerEffort: o.reviewerEffort,
          ...(o.concurrency !== undefined ? { concurrency: o.concurrency } : {}),
          // No severity ranks below `nit`, so that floor checks everything.
          verifyFloor: o.verifyFloor === "all" ? "nit" : o.verifyFloor,
          pipeline: o.pipeline,
          prNumber: o.pr,
          crossVendor: o.crossVendor,
          roundCap: o.roundCap,
          continuationCap: o.continuationCap,
          scope,
          excludePaths: o.exclude,
          ...(o.rootCauses ? { rootCauses: true } : {}),
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
    .option(
      "--all-machines",
      "List the runs of every machine, with a MACHINE column. An offline machine shows as offline.",
    )
    .action(
      async (
        runId: string | undefined,
        o: { project?: string; box?: string; allMachines?: boolean },
      ) => {
        if (o.allMachines) {
          if (runId) throw new UsageError("--all-machines lists runs; leave out the run ID.");
          if (globals().machine !== undefined) {
            throw new UsageError("Use --all-machines or --machine, not both.");
          }
          const s = settings();
          const runs = await listFleetRuns(
            await fleet(),
            (m) => clientFor(s, async () => (m.isLocal ? null : m.id)),
            { projectId: o.project, boxId: o.box },
          );
          if (runs.some((m) => m.status === "error")) state.code = 1;
          print({ machines: runs }, () => fleetRunText(runs));
          return;
        }
        const boxId = o.box === undefined ? undefined : boxRef(o.box);
        const c = client();
        if (!runId) {
          const r = await c.call("runs.list", { query: { projectId: o.project, boxId } });
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
      },
    );

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
    .command("retry")
    .description(
      "Resume a failed run from its saved state at the stage that failed, reusing saved calls.",
    )
    .argument("<runId>")
    .option(
      "--role <role=vendors>",
      "Give a role to vendors for calls that haven't started, such as disprover=codex (repeatable).",
      collect,
      [],
    )
    .addOption(
      new Option(
        "--verify-floor <severity>",
        "Send only findings at or above this severity to a disprover. Use all to remove the run's floor. Default: keep the run's floor.",
      ).choices([...SEVERITIES, "all"]),
    )
    .option(
      "--finish-with-claude",
      "Give the remaining work to Claude and turn off the cross-vendor rule, so Claude checks its own findings.",
    )
    .action(
      async (
        runId: string,
        o: { role: string[]; verifyFloor?: string; finishWithClaude?: boolean },
      ) => {
        const r = await client().call("runs.retry", {
          params: { runId },
          body: {
            roles: rolesOf(o.role),
            verifyFloor: o.verifyFloor as "P1" | "all" | undefined,
            ...(o.finishWithClaude ? { finishWithClaude: true } : {}),
          },
        });
        print(r, () => `Retried run ${r.id}; status ${r.status}, stage ${r.stage}.\n`);
      },
    );

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
    .description("Give a role to one or more vendors, for calls that haven't started.")
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
      print(r, () => `Assigned ${role} to ${vendors.join(", ")}.\n`);
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
    .command("clear-usage <vendor>")
    .description(
      "Clear a vendor's usage block when its stored sample is stale, such as after you buy a reset.",
    )
    .option("--account <id>", "Clear only this account, such as codex/work.")
    .action(async (vendor: string, o: { account?: string }) => {
      const parsed = VendorSchema.safeParse(vendor);
      if (!parsed.success) throw new UsageError(`Unknown vendor ${vendor}.`);
      const r = await client().call("usage.clear", {
        body: { vendor: parsed.data, ...(o.account !== undefined ? { account: o.account } : {}) },
      });
      print(r, () => `Cleared ${r.cleared} usage blocks for ${vendor}.\n`);
    });

  review
    .command("usage")
    .description("Show each vendor's usage in every window, against its ceiling.")
    .action(async () => {
      const r = await client().call("usage.get");
      const now = Date.parse(r.time ?? new Date().toISOString());
      print(r, () =>
        table(
          ["VENDOR", "ACCOUNT", "WINDOW", "USED", "CEILING", "OVER", "RESETS", "FORECAST"],
          r.vendors.flatMap((v) => {
            // One row per window with a sample, and the ceiling's window even without one.
            const windows = [...new Set([v.window, ...v.latest.map((s) => s.window)])].sort(
              (a, b) => WINDOW_ORDER.indexOf(a) - WINDOW_ORDER.indexOf(b),
            );
            return windows.map((window) => {
              const sample = v.latest.find((s) => s.window === window);
              const passed =
                sample?.resetAt !== null &&
                sample?.resetAt !== undefined &&
                Date.parse(sample.resetAt) <= now;
              const used = !sample
                ? null
                : passed
                  ? "reset"
                  : sample.spendUsd !== null
                    ? `$${sample.spendUsd.toFixed(2)}`
                    : percent(sample.utilization);
              const ceilingRow = window === v.window;
              return [
                v.vendor,
                v.account,
                window,
                used,
                ceilingRow ? ceilingText(v.ceiling) : null,
                ceilingRow ? (v.overCeiling ? "yes" : "no") : null,
                sample?.resetAt ?? (ceilingRow ? v.resetAt : null),
                ceilingRow ? v.forecastAt : null,
              ];
            });
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
            from: await hostPath(o.from),
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
  // machines and node (multi-host)
  const machines = thisMachineOnly(
    program
      .command("machines")
      .description("List, enroll, and revoke the machines of a multi-host setup."),
  );

  machines
    .command("list")
    .description("List the machines: this one first, then the hub's other machines.")
    .action(async () => {
      const r = await client().call("machines.list");
      print(r, () =>
        table(
          ["ID", "NAME", "ROLE", "STATUS", "VERSION", "PLATFORM", "LAST SEEN"],
          r.machines.map((m) => [
            m.isLocal ? `${m.id} (this machine)` : m.id,
            m.name,
            m.role,
            m.status,
            m.serverVersion,
            m.platform,
            m.lastSeen,
          ]),
        ),
      );
    });

  machines
    .command("enroll")
    .description(
      "Issue a one-time enrollment code on the hub. Run aio node join on the new machine with it.",
    )
    .action(async () => {
      const r = await client().call("machines.enroll");
      print(
        r,
        () =>
          `Enrollment code: ${r.code}\nIt works once, until ${r.expiresAt}. On the machine to add, run the following command, and then enter the code when the command asks for it:\n\n  aio node join ${r.hubUrl}\n`,
      );
    });

  machines
    .command("revoke")
    .description("Revoke a machine's certificate on the hub and close its link.")
    .argument("<id>", "The machine id, from aio machines list.")
    .action(async (id: string) => {
      const r = await client().call("machines.revoke", { params: { id } });
      print(r, () => `Revoked ${id}.\n`);
    });

  const gui = thisMachineOnly(
    program
      .command("gui")
      .description("On the hub, enroll, list, and revoke GUI apps on other PCs."),
  );

  gui
    .command("code")
    .description("Issue a one-time code for a GUI app on another PC to enroll with this hub.")
    .action(async () => {
      const r = await client().call("gui.enroll");
      print(
        r,
        () =>
          `GUI enrollment code: ${r.code}\nIt works once, until ${r.expiresAt}. In the app on the other PC, open the connection window, and enter the following hub URL and the code:\n\n  ${r.hubUrl}\n`,
      );
    });

  gui
    .command("list")
    .description("List the GUI apps enrolled with this hub.")
    .action(async () => {
      const r = await client().call("gui.list");
      print(r, () =>
        table(
          ["ID", "NAME", "STATUS", "LAST SEEN", "ENROLLED"],
          r.clients.map((c) => [c.id, c.name, c.status, c.lastSeen ?? "-", c.createdAt]),
        ),
      );
    });

  gui
    .command("revoke")
    .description("Revoke a GUI app's certificate and close its connections.")
    .argument("<id>", "The client ID, from aio gui list.")
    .action(async (id: string) => {
      const r = await client().call("gui.revoke", { params: { id } });
      print(r, () => `Revoked ${id}.\n`);
    });

  const node = thisMachineOnly(
    program.command("node").description("Show this machine's link to a hub, or join a hub."),
  );

  const nodeText = (s: NodeStatus) =>
    keyValues([
      ["Role", s.role],
      ["Name", s.name],
      ["Machine ID", s.machineId],
      ["Hub", s.hubUrl],
      ["Link", s.link],
      ["Error", s.error],
      ["Link port", s.linkPort],
    ]);

  node
    .command("status")
    .description("Show this machine's role and its link to a hub.")
    .action(async () => {
      const r = await client().call("node.get");
      print(r, () => nodeText(r));
    });

  node
    .command("join")
    .description(
      "Join a hub with a one-time enrollment code from aio machines enroll. The command reads the code from a prompt, or from standard input when it isn't a terminal.",
    )
    .argument(
      "<hub-url>",
      "The hub URL that came with the code, such as https://hub.example.com:21402.",
    )
    .option("--name <name>", "The name to enroll under. Default: this machine's host name.")
    .option(
      "--replace-hub",
      "Replace this machine's enrollment with a hub it already joined. The old hub lists the machine until you revoke it there.",
    )
    .action(async (hubUrl: string, o: { name?: string; replaceHub?: boolean }) => {
      const c = client();
      // The code never goes on the command line, where the process list and
      // the shell history would show it.
      const input = (deps.terminal ?? { input: process.stdin }).input;
      const prompted = Boolean(input.isTTY && input.setRawMode);
      if (prompted) deps.err("Enrollment code: ");
      let code: string;
      try {
        code = (await readSecretLine(input, deps.signal)).trim();
      } finally {
        if (prompted) deps.err("\n");
      }
      if (!code) throw new UsageError("Enter the enrollment code from the hub.");
      const r = await c.call("node.join", {
        body: { hubUrl, code, name: o.name, ...(o.replaceHub ? { replaceHub: true } : {}) },
      });
      print(r, () => `Joined ${r.hubUrl} as ${r.name} (${r.machineId}).\n${nodeText(r)}`);
    });

  for (const vendor of PlatformSchema.options) {
    thisMachineOnly(program.command(vendor))
      .description(`Run ${vendor} on this host using an AI Orchestrator account.`)
      .option("--account <name>", "Use this account instead of the vendor's default.")
      .argument("[args...]", "Vendor arguments after --.")
      .action(async (args: string[], options: { account?: string }) => {
        const prepared = await client().call("accounts.prepare", { body: { vendor, ...(options.account ? { name: options.account } : {}) } });
        for (const problem of prepared.problems) deps.err(terminalText(`${problem}\n`));
        const env = childEnv(deps.env);
        env[ACCOUNT_DIR_ENV[vendor]] = prepared.dir;
        state.code = await exec([vendor, ...args], { env });
      });
  }

  // -------------------------------------------------------------------------
  // migrate, setup, doctor, events
  program
    .command("upgrade [phase]")
    .description("Rebuild the image and restore open boxes and review runs.")
    .option("--timeout <seconds>", "Maximum wait for the server and upgrade.", "300")
    .action(async (phase: string | undefined, opts: { timeout: string }) => {
      if (phase && phase !== "prepare")
        throw new UsageError("Use aio upgrade or aio upgrade prepare.");
      const seconds = Number(opts.timeout);
      if (!Number.isFinite(seconds) || seconds <= 0)
        throw new UsageError("--timeout must be a positive number.");
      const deadline = Date.now() + seconds * 1000;
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(Math.ceil(seconds * 1000)),
        ...(deps.signal ? [deps.signal] : []),
      ]);
      const upgradeClient = () => clientFor(settings(), undefined, signal);
      if (phase === "prepare") {
        try {
          const recordFile = path.join(
            dataDirFor(deps.env, deps.home, globals().dataDir),
            "upgrade-open-work.json",
          );
          try {
            const prepared = await upgradeClient().call("upgrade.prepare");
            print(
              prepared,
              () => `Recorded ${prepared.boxes.length} boxes and ${prepared.runs.length} runs.\n`,
            );
            return;
          } catch (err) {
            // The first package upgrade is served by a version with no upgrade API.
            if (
              !(err instanceof ServerUnreachableError) &&
              !(err instanceof ApiCallError && err.status === 404)
            )
              throw err;
            let boxes: { id: string; name: string }[] = [];
            let runs: { run_id: string; name: string; projectId: string }[] = [];
            try {
              boxes = (await upgradeClient().call("boxes.list", { query: {} })).boxes
                .filter((b) => b.status === "running")
                .map((b) => ({ id: b.box.id, name: b.box.conversationName || b.box.id }));
              runs = (await upgradeClient().call("runs.list", { query: {} })).runs
                .filter((r) => ["pending", "running", "waiting_decision"].includes(r.status))
                .map((r) => ({ run_id: r.id, name: r.id, projectId: r.projectId }));
            } catch (legacyError) {
              if (!(legacyError instanceof ServerUnreachableError)) throw legacyError;
              // A previous attempt may have left work for the next startup.
              if (fs.existsSync(recordFile)) {
                deps.out("Preserved previously recorded open work.\n");
                return;
              }
            }
            fs.mkdirSync(path.dirname(recordFile), { recursive: true });
            fs.writeFileSync(`${recordFile}.tmp`, JSON.stringify({ boxes, runs }), { mode: 0o600 });
            fs.renameSync(`${recordFile}.tmp`, recordFile);
            deps.out(`Recorded ${boxes.length} boxes and ${runs.length} runs.\n`);
            return;
          }
        } catch (error) {
          if ((signal.aborted || Date.now() >= deadline) && !deps.signal?.aborted)
            throw new Error("Upgrade time limit reached; retry with sudo dpkg --configure -a.", {
              cause: error,
            });
          throw error;
        } finally {
          controller.abort();
        }
      }
      let pending = {
        boxes: [] as { id: string; name: string }[],
        runs: [] as { run_id: string; name: string }[],
      };
      try {
        pending = UpgradePreviewSchema.parse(
          JSON.parse(
            fs.readFileSync(
              path.join(
                dataDirFor(deps.env, deps.home, globals().dataDir),
                "upgrade-open-work.json",
              ),
              "utf8",
            ),
          ),
        );
      } catch {
        /* A CLI update can have no prepared package-install record. */
      }
      deps.err("Upgrading: building the image, then restoring open work.\n");
      let progressBusy = false;
      const progress = setInterval(() => {
        if (progressBusy) return;
        progressBusy = true;
        void upgradeClient()
          .call("image.status")
          .then((status) => {
            deps.err(
              status.upgrading
                ? `Upgrading: building the image${status.buildLogJobId ? ` (build log job ${status.buildLogJobId})` : ""}.\n`
                : "Upgrading: restoring open work.\n",
            );
          })
          .catch(() => {})
          .finally(() => {
            progressBusy = false;
          });
      }, 5000);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let printedSummary = false;
      try {
        while (true) {
          try {
            await upgradeClient().call("health");
            break;
          } catch (err) {
            if (!(err instanceof ServerUnreachableError) || Date.now() >= deadline) throw err;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(1, Math.min(500, deadline - Date.now()))),
            );
          }
        }
        const report = await Promise.race([
          upgradeClient()
            .call("upgrade.start")
            .catch((err) => {
              if ((signal.aborted || Date.now() >= deadline) && !deps.signal?.aborted)
                throw new Error("Upgrade time limit reached; retry with sudo dpkg --configure -a.");
              throw err;
            }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error("Upgrade time limit reached; retry with sudo dpkg --configure -a."),
                ),
              Math.max(1, deadline - Date.now()),
            );
          }),
        ]);
        print(
          report,
          () =>
            [
              report.image === "failed"
                ? `Image build failed: ${report.error}`
                : `Image built with ${report.image === "pinned" ? "pinned CLI versions (latest failed; fallback used)" : "latest CLI versions"}.`,
              ...report.boxes.map(
                (b) => `Box ${b.name} (${b.id}): ${b.restored ? "restored" : b.reason}`,
              ),
              ...report.runs.map((r) => `Run ${r.name}: ${r.restored ? "resumed" : r.reason}`),
            ].join("\n") + "\n",
        );
        printedSummary = true;
        if (
          report.error ||
          report.boxes.some((b) => !b.restored && !b.gone) ||
          report.runs.some((r) => !r.restored && !r.gone)
        )
          throw new Error(
            report.error ?? "Some open work could not be restored; see summary above.",
          );
      } catch (caught) {
        const error =
          (signal.aborted || Date.now() >= deadline) && !deps.signal?.aborted
            ? new Error("Upgrade time limit reached; retry with sudo dpkg --configure -a.")
            : caught;
        if (!printedSummary && /time limit/i.test((error as Error).message)) {
          for (const box of pending.boxes)
            deps.out(
              `Box ${box.name} (${box.id}): restoration unconfirmed; upgrade time limit reached.\n`,
            );
          for (const run of pending.runs)
            deps.out(`Run ${run.name}: restoration unconfirmed; upgrade time limit reached.\n`);
        }
        throw error;
      } finally {
        controller.abort();
        clearInterval(progress);
        clearTimeout(timer);
      }
    });

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

  thisMachineOnly(program.command("doctor"))
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
    .description(
      "Print the server's event stream as JSON lines until interrupted. Another machine's events carry its ID in the machine field.",
    )
    .option("--types <types>", "Comma-separated event types to receive.")
    .option("--count <n>", "Exit after this many events.", positiveInt)
    .option(
      "--all-machines",
      "Print the events of every online machine of a multi-host setup, merged in arrival order.",
    )
    .action(async (o: { types?: string; count?: number; allMachines?: boolean }) => {
      const s = settings();
      if (s.token === null)
        throw new ApiCallError(401, "unauthorized", `No token in AIO_TOKEN or ${s.tokenFile}.`);
      const token = s.token;
      const tail = (
        machine: string | null,
        write: (line: string) => void,
        signal?: AbortSignal,
        onEvent?: () => void,
      ) =>
        tailEvents({
          baseUrl: s.baseUrl,
          token,
          types: o.types,
          machine,
          write,
          onEvent,
          warn: deps.err,
          WebSocket: deps.WebSocket,
          tls: serverTls(s),
          signal,
          ...(o.allMachines ? {} : { count: o.count }),
        });
      if (!o.allMachines) {
        await tail((await target())?.id ?? null, deps.out, deps.signal);
        return;
      }
      if (globals().machine !== undefined) {
        throw new UsageError("Use --all-machines or --machine, not both.");
      }
      // One stream per online machine. `--count` counts every stream's
      // events together, and ends them all.
      const machines = (await fleet()).filter((m) => m.isLocal || m.status === "online");
      const done = new AbortController();
      const signal = deps.signal ? AbortSignal.any([deps.signal, done.signal]) : done.signal;
      let seen = 0;
      const write = (line: string) => {
        if (!done.signal.aborted) deps.out(line);
      };
      const onEvent = () => {
        seen += 1;
        if (o.count !== undefined && seen >= o.count) done.abort();
      };
      // Another machine's stream that ends early, cleanly or not, leaves the
      // merged stream partial: warn, keep tailing the others, and exit 1.
      const lost = (name: string, why: string) => {
        state.code = 1;
        deps.err(terminalText(`Warning: no more events from ${name}: ${why}\n`));
      };
      await Promise.all(
        machines.map((m) =>
          tail(m.isLocal ? null : m.id, write, signal, onEvent).then(
            () => {
              if (!m.isLocal && !signal.aborted) lost(m.name, "Its event stream closed.");
            },
            (err: unknown) => {
              // This server's own stream must work; another machine's failure
              // ends only its own stream.
              if (m.isLocal) {
                done.abort();
                throw err;
              }
              lost(m.name, err instanceof Error ? err.message : String(err));
            },
          ),
        ),
      );
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
