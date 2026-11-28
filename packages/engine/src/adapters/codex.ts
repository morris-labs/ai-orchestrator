// The Codex adapter: `codex exec --json`. The Codex CLI isn't installed where
// this was written; the flags and event shapes it relies on come from the
// Codex CLI's documentation and are checked against the sample fixtures.
import {
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageSample, UsageWindow } from "@aio/contracts";
import {
  CliAdapter,
  limitFromError,
  epochToIso,
  type CallContext,
  type CliAdapterOptions,
} from "./base.js";
import { parseStructuredText, toStrictJsonSchema } from "./output.js";
import { runProcess } from "./process.js";
import {
  AdapterError,
  TEAM_TOKEN_ENV,
  type CliRequest,
  type CliResult,
  type CliLimitInfo,
  type TokenCounts,
} from "./types.js";

export interface CodexAdapterOptions extends CliAdapterOptions {
  /**
   * Which sandbox confines Codex. `container` (the default) passes
   * `--sandbox danger-full-access` to every call: the project container is
   * the sandbox, since Codex's own sandbox can't start in it (bubblewrap
   * needs user namespaces that the host refuses). The engine then checks
   * after each read-only call that the worktree didn't change. `codex` uses
   * Codex's own sandbox: `read-only`, or `workspace-write` for a write call
   * and for a read-only call with a scratch directory.
   */
  sandbox?: "container" | "codex";
  /**
   * `CODEX_HOME`, where the session rollout files live. Default: the
   * `CODEX_HOME` the child gets (from `env`, `accountDir`, or the engine's
   * environment), or `~/.codex`.
   */
  codexHome?: string;
}

export interface CodexStreamSummary {
  threadId: string | null;
  /** The text of the last `agent_message` item. */
  lastMessage: string | null;
  /**
   * Commands that failed or were declined, as `command: output` (the output
   * cut to its last 300 characters). A failing test is in here as well as
   * a sandbox that couldn't start the command.
   */
  toolErrors: string[];
  tokens: TokenCounts;
  /** Messages from `turn.failed` and top-level `error` events. */
  errors: string[];
  turnsCompleted: number;
  badLines: number;
}

export class CodexAdapter extends CliAdapter {
  readonly vendor = "codex" as const;
  private readonly codexOptions: CodexAdapterOptions;

  constructor(options: CodexAdapterOptions = {}) {
    super(options);
    this.codexOptions = options;
  }

  protected versionArgs(): string[] {
    return ["--version"];
  }

  /** `codexHome` takes the account folder's place, so the child and the rollout lookup agree. */
  protected override accountDir(): string | undefined {
    return this.codexOptions.codexHome ?? super.accountDir();
  }

  private homeFor(req?: CliRequest<unknown>): string {
    return this.configDir(req) ?? join(homedir(), ".codex");
  }

  /**
   * Where Codex runs: the scratch directory for a read-only call that has
   * one, since `workspace-write` makes the working directory writable, and
   * the repository otherwise. The prompt names the repository's path.
   */
  workingDir(req: CliRequest<unknown>): string {
    return req.tools === "read-only" && req.scratchDir ? req.scratchDir : req.cwd;
  }

  private get containerSandbox(): boolean {
    return this.codexOptions.sandbox !== "codex";
  }

  /** The arguments for one call; the prompt goes on stdin through the `-` positional. */
  buildArgs(req: CliRequest<unknown>, schemaFile: string): string[] {
    const args = ["exec"];
    // A read-only call with a scratch directory runs in that directory, so
    // under Codex's own sandbox `workspace-write` makes the scratch directory
    // the only writable root; the temporary directories are excluded so the
    // base checkout stays read-only too.
    const scratch = req.tools === "read-only" && req.scratchDir !== undefined;
    // `--sandbox` isn't a global flag, so it goes before `resume`.
    if (this.containerSandbox) args.push("--sandbox", "danger-full-access");
    else args.push("--sandbox", req.tools === "write" || scratch ? "workspace-write" : "read-only");
    if (req.sessionId) args.push("resume", req.sessionId);
    args.push("--json", "--skip-git-repo-check", "--output-schema", schemaFile);
    if (scratch && !this.containerSandbox) {
      args.push(
        "-c",
        "sandbox_workspace_write.exclude_slash_tmp=true",
        "-c",
        "sandbox_workspace_write.exclude_tmpdir_env_var=true",
        "-c",
        "sandbox_workspace_write.network_access=false",
      );
    }
    if (req.model) args.push("--model", req.model);
    if (req.effort) args.push("-c", `model_reasoning_effort="${req.effort}"`);
    if (req.team) {
      // Codex reads the server from each call's own configuration, a resume
      // included, and refuses every tool call that needs approval under
      // `codex exec` unless the server approves its tools. The token comes
      // from the child's environment (see `vendor-cli-facts.md`).
      const key = `mcp_servers.${req.team.server}`;
      args.push(
        "-c",
        `${key}.url=${JSON.stringify(req.team.url)}`,
        "-c",
        `${key}.bearer_token_env_var=${JSON.stringify(TEAM_TOKEN_ENV)}`,
        "-c",
        `${key}.default_tools_approval_mode="approve"`,
      );
    }
    args.push("-");
    return args;
  }

  protected async call<T>(req: CliRequest<T>, _ctx: CallContext): Promise<CliResult<T>> {
    const dir = mkdtempSync(join(tmpdir(), "aio-codex-"));
    try {
      const schemaFile = join(dir, "schema.json");
      writeFileSync(schemaFile, JSON.stringify(toStrictJsonSchema(this.jsonSchemaFor(req))));
      // A resumed call's `turn.completed` reports the whole thread's total, so
      // the parser needs the total from before this call to isolate the turn.
      const beforeRollout = req.sessionId ? this.readRollout(req.sessionId, req) : null;
      const before = beforeRollout ? codexRolloutTotals(beforeRollout) : undefined;
      const parser = new CodexStreamParser(before);
      const prompt = req.systemPrompt ? `${req.systemPrompt}\n\n${req.prompt}` : req.prompt;
      const startedMs = Date.now();
      const result = await runProcess({
        command: this.command,
        args: this.buildArgs(req, schemaFile),
        cwd: this.workingDir(req),
        input: prompt,
        env: req.team
          ? { ...this.envFor(req), [TEAM_TOKEN_ENV]: req.team.token }
          : this.envFor(req),
        envProfile: `vendor:${this.vendor}`,
        timeoutMs: req.timeoutMs,
        signal: req.signal,
        onLine: (line) => parser.push(line),
      });
      const summary = parser.summary();
      const sessionId = summary.threadId ?? req.sessionId ?? null;
      // Read before any failure check: a failed or limited call's reading is
      // the freshest usage there is, and the only way to learn a limit reset.
      const rollout = sessionId ? this.readRollout(sessionId, req) : null;
      const usage = rollout
        ? codexRateLimitSamples(rollout, this.accountFor(req), this.ceiling)
        : [];
      for (const sample of usage) req.onUsage?.(sample);
      // The thread's own counts leave out the subagents it spawned.
      const subagents = sessionId
        ? codexSubagentTokens(join(this.homeFor(req), "sessions"), sessionId, startedMs)
        : undefined;
      const withSubagents = (tokens: TokenCounts | undefined): TokenCounts | undefined =>
        subagents ? (tokens ? addTokenCounts(tokens, subagents) : subagents) : tokens;
      // A failed or stopped call spent tokens too, so its error carries what
      // the rollout says it spent.
      const spent = (error: unknown): unknown => {
        if (error instanceof AdapterError)
          error.tokens = withSubagents(failedCallTokens(rollout, before, summary.tokens));
        return error;
      };
      const failure = this.processFailure(result, req);
      if (failure) throw spent(failure);

      // `turn.failed` and top-level `error` events are fatal; item-level errors aren't collected.
      if (result.exitCode !== 0 || summary.errors.length > 0 || summary.lastMessage === null) {
        throw spent(
          this.exitFailure(
            result,
            sessionId,
            summary.errors.join("\n") || "Codex returned no agent message.",
          ),
        );
      }

      let output: T;
      try {
        output = parseStructuredText(
          "codex",
          req.outputSchema,
          summary.lastMessage ?? "",
          result.stdout,
          sessionId,
        );
      } catch (error) {
        throw spent(error);
      }
      const actual = rollout ? codexRolloutModel(rollout) : null;
      return {
        output,
        sessionId,
        model: actual ?? req.model ?? null,
        usage,
        tokens: withSubagents(summary.tokens) ?? summary.tokens,
        toolErrors: summary.toolErrors,
        premiumRequests: 0,
        raw: result.stdout,
        durationMs: result.durationMs,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The thread's rollout file, or `null` when Codex wrote none that can be read. */
  private readRollout(threadId: string, req?: CliRequest<unknown>): string | null {
    const file = findRolloutFile(join(this.homeFor(req), "sessions"), threadId);
    if (!file) return null;
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }

  /** The model the CLI says it used, from the thread's rollout file. */
  rolloutModel(threadId: string): string | null {
    const rollout = this.readRollout(threadId);
    return rollout === null ? null : codexRolloutModel(rollout);
  }

  /** Reads the newest rate-limit reading from the thread's rollout file. */
  rateLimitSamples(threadId: string): UsageSample[] {
    const rollout = this.readRollout(threadId);
    return rollout === null ? [] : codexRateLimitSamples(rollout, this.account, this.ceiling);
  }

  detectLimit(error: unknown): CliLimitInfo | null {
    return limitFromError(error, this.now());
  }
}

/**
 * The tokens a failed or stopped call spent: the change in the thread's
 * rollout total since `before`, or, without a rollout total, the turns that
 * the stream completed. `undefined` when neither shows any.
 */
export function failedCallTokens(
  rollout: string | null,
  before: CodexTotals | undefined,
  streamed: TokenCounts,
): TokenCounts | undefined {
  const total = rollout ? codexRolloutTotals(rollout) : undefined;
  if (!total) return streamed.input > 0 || streamed.output > 0 ? streamed : undefined;
  const input = Math.max(0, total.input - (before?.input ?? 0));
  const cached = Math.min(input, Math.max(0, total.cached - (before?.cached ?? 0)));
  return {
    input,
    output: Math.max(0, total.output - (before?.output ?? 0)),
    // `input_tokens` includes `cached_input_tokens`, which are cache reads.
    fresh: input - cached,
    cacheWrite: 0,
    cacheRead: cached,
  };
}

/** The model of the last `turn_context` line in a rollout file, or `null`. */
export function codexRolloutModel(rollout: string): string | null {
  let model: string | null = null;
  for (const line of rollout.split("\n")) {
    if (!line.includes('"turn_context"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; payload?: { model?: unknown } };
      if (event.type === "turn_context" && typeof event.payload?.model === "string") {
        model = event.payload.model;
      }
    } catch {
      // A torn line says nothing about the model.
    }
  }
  return model;
}

/** Cumulative token counts for a thread, as Codex reports them. */
export interface CodexTotals {
  input: number;
  output: number;
  cached: number;
}

/**
 * Reads the thread's cumulative token counts from the last `token_count`
 * event in a rollout file, or `undefined` when the file holds none. With
 * `beforeMs`, only the events stamped before that time count.
 */
export function codexRolloutTotals(rollout: string, beforeMs?: number): CodexTotals | undefined {
  let totals: CodexTotals | undefined;
  for (const line of rollout.split("\n")) {
    if (!line.includes("total_token_usage")) continue;
    try {
      const entry = JSON.parse(line) as {
        timestamp?: unknown;
        payload?: { type?: unknown; info?: { total_token_usage?: Record<string, unknown> } | null };
      };
      if (beforeMs !== undefined) {
        const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        if (!(at < beforeMs)) continue;
      }
      const usage = entry.payload?.info?.total_token_usage;
      if (entry.payload?.type === "token_count" && usage) {
        totals = {
          input: num(usage.input_tokens),
          output: num(usage.output_tokens),
          cached: num(usage.cached_input_tokens),
        };
      }
    } catch {
      // Skip a torn line; the file can be mid-write.
    }
  }
  return totals;
}

/**
 * Reads `codex exec --json` lines one at a time.
 *
 * The usage in each `turn.completed` event is the thread's running total, so
 * the parser reports the change since the previous total. Pass the thread's
 * total from before the call as `before` when the call resumes a session.
 */
export class CodexStreamParser {
  constructor(before?: CodexTotals) {
    if (before) this.previous = before;
  }

  private previous: CodexTotals = { input: 0, output: 0, cached: 0 };
  private threadId: string | null = null;
  private lastMessage: string | null = null;
  private readonly toolErrors: string[] = [];
  private input = 0;
  private output = 0;
  private cached = 0;
  /** Whether some turn left out `cached_input_tokens`, so the cache split is unknown. */
  private cacheUnknown = false;
  private readonly errors: string[] = [];
  private turnsCompleted = 0;
  private badLines = 0;

  push(line: string): void {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
      event = parsed as Record<string, unknown>;
    } catch {
      this.badLines += 1;
      return;
    }
    switch (event.type) {
      case "thread.started":
        if (typeof event.thread_id === "string") this.threadId = event.thread_id;
        break;
      case "turn.completed": {
        this.turnsCompleted += 1;
        const usage = (event.usage ?? {}) as Record<string, unknown>;
        const total = {
          input: num(usage.input_tokens),
          output: num(usage.output_tokens),
          cached: num(usage.cached_input_tokens),
        };
        this.input += Math.max(0, total.input - this.previous.input);
        this.output += Math.max(0, total.output - this.previous.output);
        // `input_tokens` includes `cached_input_tokens`, which are cache reads.
        if (typeof usage.cached_input_tokens === "number") {
          this.cached += Math.max(0, total.cached - this.previous.cached);
        } else {
          this.cacheUnknown = true;
        }
        this.previous = total;
        break;
      }
      case "turn.failed": {
        const error = event.error as { message?: unknown } | undefined;
        this.errors.push(typeof error?.message === "string" ? error.message : "The turn failed.");
        break;
      }
      case "error":
        this.errors.push(
          typeof event.message === "string" ? event.message : "Codex reported an error.",
        );
        break;
      case "item.completed": {
        const item = event.item as Record<string, unknown> | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string")
          this.lastMessage = item.text;
        else if (
          item?.type === "command_execution" &&
          (item.status === "failed" || item.status === "declined")
        ) {
          const command = typeof item.command === "string" ? item.command : "a command";
          const output =
            typeof item.aggregated_output === "string" ? item.aggregated_output.trim() : "";
          this.toolErrors.push(
            `${command}: ${output.length > 300 ? output.slice(-300) : output || String(item.status)}`,
          );
        } else if (item?.type === "mcp_tool_call" && item.status === "failed") {
          const error = item.error as { message?: unknown } | undefined;
          const message =
            typeof error?.message === "string" ? error.message : "the tool call failed";
          this.toolErrors.push(
            `${String(item.server)}.${String(item.tool)}: ${message.slice(-300)}`,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  summary(): CodexStreamSummary {
    return {
      threadId: this.threadId,
      lastMessage: this.lastMessage,
      toolErrors: [...this.toolErrors],
      // Without a cache count, a breakdown would claim every input token
      // is fresh, so the summary reports only the totals.
      tokens: this.cacheUnknown
        ? { input: this.input, output: this.output }
        : {
            input: this.input,
            output: this.output,
            fresh: Math.max(0, this.input - this.cached),
            cacheWrite: 0,
            cacheRead: Math.min(this.cached, this.input),
          },
      errors: [...this.errors],
      turnsCompleted: this.turnsCompleted,
      badLines: this.badLines,
    };
  }
}

/**
 * Converts the last `token_count` event with `rate_limits` in a rollout file
 * into usage samples. A 300-minute window maps to `5h` and a 10080-minute
 * window to `7d`; other windows are skipped.
 */
export function codexRateLimitSamples(
  rollout: string,
  account: string,
  ceiling: UsageSample["ceiling"],
): UsageSample[] {
  let limits: Record<string, unknown> | null = null;
  for (const line of rollout.split("\n")) {
    if (!line.includes("rate_limits")) continue;
    try {
      const entry = JSON.parse(line) as { payload?: { type?: unknown; rate_limits?: unknown } };
      const payload = entry.payload;
      if (
        payload?.type === "token_count" &&
        payload.rate_limits &&
        typeof payload.rate_limits === "object"
      ) {
        limits = payload.rate_limits as Record<string, unknown>;
      }
    } catch {
      // Skip a torn line; the file can be mid-write.
    }
  }
  if (!limits) return [];
  const samples: UsageSample[] = [];
  for (const key of ["primary", "secondary"]) {
    const w = limits[key] as Record<string, unknown> | null | undefined;
    if (!w || typeof w.used_percent !== "number") continue;
    const window = windowFor(num(w.window_minutes));
    if (!window) continue;
    samples.push({
      vendor: "codex",
      account,
      window,
      utilization: Math.max(0, w.used_percent / 100),
      spendUsd: null,
      ceiling,
      resetAt: epochToIso(w.resets_at),
      sampleSource: "codex_session",
    });
  }
  return samples;
}

/** The most of a rollout file's first line that `sessionMeta()` reads. */
const SESSION_META_LIMIT = 4 * 1024 * 1024;

/** The `session_meta` payload on a rollout file's first line, or `null`. */
function sessionMeta(file: string): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    const chunk = Buffer.alloc(64 * 1024);
    while (size < SESSION_META_LIMIT) {
      const n = readSync(fd, chunk, 0, chunk.length, size);
      if (n === 0) break;
      const end = chunk.subarray(0, n).indexOf(10);
      chunks.push(Buffer.from(chunk.subarray(0, end === -1 ? n : end)));
      size += n;
      if (end !== -1) break;
    }
    const entry = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      type?: unknown;
      payload?: Record<string, unknown>;
    };
    return entry.type === "session_meta" && entry.payload ? entry.payload : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The thread that spawned a subagent's rollout, from its `session_meta` payload, or `null`. */
function subagentParent(meta: Record<string, unknown>): string | null {
  if (meta.thread_source !== "subagent") return null;
  return typeof meta.parent_thread_id === "string" ? meta.parent_thread_id : null;
}

/**
 * The tokens that the subagents of thread `threadId` spent since `sinceMs`,
 * or `undefined` when none did. A large-tier Codex call can spawn
 * subagents: each writes a rollout of its own, with `thread_source:
 * subagent` and the spawning thread's id in `parent_thread_id`, and token
 * totals that start at zero. The thread's own totals leave them out. A
 * subagent's subagents count too. Only rollout files written since
 * `sinceMs` are read, and of each, only the part of its total after
 * `sinceMs`, so a resumed call doesn't count an earlier call's subagents.
 */
export function codexSubagentTokens(
  sessionsDir: string,
  threadId: string,
  sinceMs: number,
): TokenCounts | undefined {
  const candidates: { file: string; parent: string; id: string }[] = [];
  for (const dir of recentDayDirs(sessionsDir)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      try {
        if (statSync(file).mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
      const meta = sessionMeta(file);
      const parent = meta ? subagentParent(meta) : null;
      if (meta && parent && typeof meta.id === "string")
        candidates.push({ file, parent, id: meta.id });
    }
  }
  const threads = new Set([threadId]);
  const counted = new Set<string>();
  let total: CodexTotals | undefined;
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of candidates) {
      if (counted.has(c.file) || !threads.has(c.parent)) continue;
      counted.add(c.file);
      threads.add(c.id);
      grew = true;
      let text: string;
      try {
        text = readFileSync(c.file, "utf8");
      } catch {
        continue;
      }
      const after = codexRolloutTotals(text);
      if (!after) continue;
      const before = codexRolloutTotals(text, sinceMs);
      total ??= { input: 0, output: 0, cached: 0 };
      total.input += Math.max(0, after.input - (before?.input ?? 0));
      total.output += Math.max(0, after.output - (before?.output ?? 0));
      total.cached += Math.max(0, after.cached - (before?.cached ?? 0));
    }
  }
  if (!total || (total.input === 0 && total.output === 0)) return undefined;
  const cached = Math.min(total.cached, total.input);
  return {
    input: total.input,
    output: total.output,
    // `input_tokens` includes `cached_input_tokens`, which are cache reads.
    fresh: total.input - cached,
    cacheWrite: 0,
    cacheRead: cached,
  };
}

/**
 * `a` plus `b`. The sum keeps a breakdown only when both have one: without
 * it, a breakdown would understate the fresh or cached tokens.
 */
export function addTokenCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  const sum: TokenCounts = { input: a.input + b.input, output: a.output + b.output };
  if (a.fresh === undefined || b.fresh === undefined) return sum;
  return {
    ...sum,
    fresh: a.fresh + b.fresh,
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
  };
}

function windowFor(minutes: number): UsageWindow | null {
  if (minutes >= 240 && minutes <= 360) return "5h";
  if (minutes >= 9000 && minutes <= 11000) return "7d";
  return null;
}

/**
 * Finds `rollout-*<threadId>.jsonl` under `sessions/YYYY/MM/DD`, searching
 * the newest day directories first and stopping after a week of them.
 */
export function findRolloutFile(sessionsDir: string, threadId: string): string | null {
  for (const dir of recentDayDirs(sessionsDir)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const name = names.find((n) => n.startsWith("rollout-") && n.endsWith(`${threadId}.jsonl`));
    if (name) return join(dir, name);
  }
  return null;
}

/** The `sessions/YYYY/MM/DD` directories, newest first, at most a week of them. */
function recentDayDirs(sessionsDir: string): string[] {
  const days: string[] = [];
  for (const year of listDirs(sessionsDir)) {
    for (const month of listDirs(join(sessionsDir, year))) {
      for (const day of listDirs(join(sessionsDir, year, month)))
        days.push(join(sessionsDir, year, month, day));
    }
  }
  return days.sort().reverse().slice(0, 7);
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
