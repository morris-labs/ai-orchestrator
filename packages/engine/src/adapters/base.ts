// Shared plumbing for the CLI adapters: the method-to-role mapping, common
// options, process failures, and limit detection from text.
import {
  ACCOUNT_DIR_ENV,
  DEFAULT_CEILINGS,
  type AgentRole,
  type Ceiling,
  type Vendor,
} from "@aio/contracts";
import type { AccountDirSource } from "./account-dirs.js";
import { toJsonSchema } from "./output.js";
import type { ProcessResult } from "./process.js";
import {
  AdapterError,
  METHOD_ROLES,
  type AdapterHealth,
  type AdapterMethod,
  type CliRequest,
  type CliResult,
  type CliLimitInfo,
  type CliVendorAdapter,
} from "./types.js";
import { runProcess } from "./process.js";

export interface CliAdapterOptions {
  /** The program to run. Defaults to the vendor's CLI name, found on `PATH`. */
  command?: string;
  /** Account label for usage samples, such as an email address. */
  account?: string;
  /**
   * The account folder the CLI uses, as a folder or a source that the
   * adapter asks on every call. The adapter sets the vendor's variable from
   * it (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or `COPILOT_HOME`); `env` wins
   * over it. Absent, or a source that returns `undefined`, leaves the CLI on
   * its home folder.
   */
  accountDir?: string | AccountDirSource;
  /** The ceiling to stamp on usage samples. Defaults to the contract default. */
  ceiling?: Ceiling;
  /** Extra environment for the child; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
  /** Clock, for tests. */
  now?: () => Date;
}

/** Environment every vendor call gets unless `CliAdapterOptions.env` overrides it. */
export const VENDOR_ENV: Record<string, string> = { PYTHONDONTWRITEBYTECODE: "1" };

/** How many sessions an adapter remembers the account folder of. */
const MAX_SESSION_FOLDERS = 1000;

/** Context each concrete adapter gets for one call. */
export interface CallContext {
  method: AdapterMethod;
  role: AgentRole;
}

export abstract class CliAdapter implements CliVendorAdapter {
  abstract readonly vendor: Vendor;
  protected readonly options: CliAdapterOptions;
  /** The account folder of each session this adapter started, newest last. */
  private readonly sessionFolders = new Map<string, string | undefined>();

  constructor(options: CliAdapterOptions = {}) {
    this.options = options;
  }

  protected abstract call<T>(req: CliRequest<T>, ctx: CallContext): Promise<CliResult<T>>;
  protected abstract versionArgs(): string[];
  abstract detectLimit(error: unknown): CliLimitInfo | null;

  /**
   * The extra environment for every call: `options.env` over the account
   * folder's variable over the engine's defaults. Python skips its
   * `__pycache__` directories, as for the gate (`GATE_ENV`), so a vendor
   * that runs the repository's Python doesn't leave bytecode in a worktree
   * that the read-only guard checks.
   */
  protected get env(): Record<string, string | undefined> {
    return this.envWith(this.accountDir());
  }

  /** The environment of one call, whose folder `dispatch` chose once. */
  protected envFor(req: CliRequest<unknown>): Record<string, string | undefined> {
    return "accountFolder" in req ? this.envWith(req.accountFolder) : this.env;
  }

  private envWith(dir: string | undefined): Record<string, string | undefined> {
    return {
      ...VENDOR_ENV,
      ...(dir === undefined ? {} : { [ACCOUNT_DIR_ENV[this.vendor]]: dir }),
      ...this.options.env,
    };
  }

  /** The account folder from `options.accountDir`, or `undefined`. */
  protected accountDir(): string | undefined {
    const source = this.options.accountDir;
    const dir = typeof source === "function" ? source() : source;
    return dir === undefined || dir === "" ? undefined : dir;
  }

  /**
   * The folder the CLI keeps its configuration in for a call made now: the
   * vendor's variable as the child gets it, or `undefined` when the CLI
   * falls back to its home folder.
   */
  protected configDir(req?: CliRequest<unknown>): string | undefined {
    const name = ACCOUNT_DIR_ENV[this.vendor];
    const env = req ? this.envFor(req) : this.env;
    if (name in env) return env[name] || undefined;
    return process.env[name] || undefined;
  }

  protected get command(): string {
    return this.options.command ?? this.vendor;
  }

  protected get ceiling(): Ceiling {
    return this.options.ceiling ?? DEFAULT_CEILINGS[this.vendor];
  }

  /**
   * The usage label: `options.account`, the account id when the config folder
   * is an account's (`VENDOR/NAME`), or a fallback name.
   */
  protected get account(): string {
    return this.accountFor();
  }

  /** The usage label of one call, from the folder `dispatch` chose for it. */
  protected accountFor(req?: CliRequest<unknown>): string {
    return this.options.account ?? this.accountIn(this.configDir(req)) ?? `${this.vendor}-default`;
  }

  /** The account id of a config folder, or `undefined` for any other folder. */
  protected accountIn(dir: string | undefined): string | undefined {
    const name = dir?.match(new RegExp(`/accounts/${this.vendor}/([^/]+)/?$`))?.[1];
    return name === undefined ? undefined : `${this.vendor}/${name}`;
  }

  protected now(): Date {
    return this.options.now?.() ?? new Date();
  }

  protected jsonSchemaFor(req: CliRequest<unknown>): Record<string, unknown> {
    return req.jsonSchema ?? toJsonSchema(req.outputSchema);
  }

  review<T>(req: CliRequest<T>): Promise<CliResult<T>> {
    return this.dispatch("review", req);
  }

  continueReview<T>(req: CliRequest<T> & { sessionId: string }): Promise<CliResult<T>> {
    if (!req.sessionId) {
      return Promise.reject(
        new AdapterError(
          this.vendor,
          "process",
          "A continuation needs the session id of the review it continues.",
        ),
      );
    }
    return this.dispatch("continueReview", req);
  }

  verify<T>(req: CliRequest<T>): Promise<CliResult<T>> {
    return this.dispatch("verify", req);
  }

  verifyBatch<T>(req: CliRequest<T>): Promise<CliResult<T>> {
    return this.dispatch("verifyBatch", req);
  }

  fix<T>(req: CliRequest<T>): Promise<CliResult<T>> {
    return this.dispatch("fix", req);
  }

  confirm<T>(req: CliRequest<T>): Promise<CliResult<T>> {
    return this.dispatch("confirm", req);
  }

  sweep<T>(req: CliRequest<T>): Promise<CliResult<T>> {
    return this.dispatch("sweep", req);
  }

  async health(): Promise<AdapterHealth> {
    const result = await runProcess({
      command: this.command,
      args: this.versionArgs(),
      cwd: process.cwd(),
      env: this.env,
      envProfile: `vendor:${this.vendor}`,
      timeoutMs: 15_000,
    });
    if (result.spawnError || result.exitCode !== 0) {
      const error = result.spawnError
        ? `${this.command} could not start: ${result.spawnError.code ?? result.spawnError.message}`
        : `${this.command} exited with code ${String(result.exitCode)}: ${tail(result.stderr || result.stdout)}`;
      return { vendor: this.vendor, available: false, version: null, error };
    }
    const version = result.stdout.trim().split("\n")[0] ?? "";
    return { vendor: this.vendor, available: true, version: version || null, error: null };
  }

  private async dispatch<T>(method: AdapterMethod, req: CliRequest<T>): Promise<CliResult<T>> {
    // A continuation keeps its session and the folder that holds the session;
    // every other role starts fresh, as the design asks, even when the caller
    // left a session id on the request. The folder is read once, so a change
    // of default during a call can't split it.
    const continuing = method === "continueReview" && req.sessionId !== undefined;
    // A session started on the home folder is saved as `undefined`, which is
    // a known folder, not a reason to read the default.
    const pinned = continuing && this.sessionFolders.has(req.sessionId as string);
    const accountFolder = pinned
      ? this.sessionFolders.get(req.sessionId as string)
      : this.accountDir();
    const request = {
      ...req,
      accountFolder,
      ...(method === "continueReview" ? {} : { sessionId: undefined }),
    };
    const result = await this.call(request, { method, role: METHOD_ROLES[method] });
    if (result.sessionId) {
      this.sessionFolders.set(result.sessionId, accountFolder);
      if (this.sessionFolders.size > MAX_SESSION_FOLDERS) {
        const oldest = this.sessionFolders.keys().next().value;
        if (oldest !== undefined) this.sessionFolders.delete(oldest);
      }
    }
    return result;
  }

  /**
   * Turns a failed process into an `AdapterError`, or returns `null` when the
   * process neither failed to start, timed out, nor was cancelled.
   */
  protected processFailure(result: ProcessResult, req: CliRequest<unknown>): AdapterError | null {
    if (result.spawnError) {
      return new AdapterError(
        this.vendor,
        "unavailable",
        `${this.command} could not start: ${result.spawnError.code ?? result.spawnError.message}`,
        { cause: result.spawnError },
      );
    }
    if (result.cancelled) {
      return new AdapterError(this.vendor, "cancelled", `The ${this.vendor} call was cancelled.`, {
        raw: result.stdout,
      });
    }
    if (result.timedOut) {
      return new AdapterError(
        this.vendor,
        "timeout",
        `The ${this.vendor} call ran past ${req.timeoutMs} ms and was stopped.`,
        {
          raw: result.stdout,
        },
      );
    }
    return null;
  }

  /**
   * The error for a nonzero exit, classified by the CLI's error channels:
   * `text` (the error events the adapter collected) and stderr. Stdout
   * carries the model's own words and tool output, so it never decides
   * that a call hit a limit.
   */
  protected exitFailure(result: ProcessResult, sessionId: string | null, text = ""): AdapterError {
    const combined = `${text}\n${result.stderr}`;
    const limit = detectLimitInText(combined, this.now());
    if (limit) {
      return new AdapterError(this.vendor, "limit", limit.message, {
        limit,
        exitCode: result.exitCode,
        raw: result.stdout,
        sessionId,
      });
    }
    const kind = AUTH_PATTERN.test(combined) ? "auth" : "process";
    return new AdapterError(
      this.vendor,
      kind,
      `${this.command} exited with code ${String(result.exitCode)}: ${tail(text || result.stderr || result.stdout)}`,
      { exitCode: result.exitCode, raw: result.stdout, sessionId },
    );
  }
}

/**
 * The limit an error carries. An `AdapterError` has one only when the
 * adapter found it on the CLI's error channels; its message and raw output
 * aren't searched again, since they can hold the model's text. Any other
 * error, such as a test double's, is read by its message.
 */
export function limitFromError(error: unknown, now: Date = new Date()): CliLimitInfo | null {
  if (error instanceof AdapterError) return error.limit;
  if (error instanceof Error) return detectLimitInText(error.message, now);
  return typeof error === "string" ? detectLimitInText(error, now) : null;
}

/** Text that means the CLI isn't signed in. */
export const AUTH_PATTERN =
  /not logged in|please run \/login|authentication[_ ]failed|unauthorized|\b401\b|not authenticated|no authentication|login required|please (?:sign|log) ?in/i;

const USAGE_LIMIT_PATTERN =
  /usage limit|hit your (?:usage )?limit|(?:5-hour|five[- ]hour|weekly|7-day|monthly|session) limit|quota (?:exceeded|exhausted)|usage_limit_reached|insufficient_quota|out of (?:premium requests|credits)|premium request(?:s)? (?:limit|quota|allowance)|exceeded your (?:copilot )?(?:quota|limit|budget)|budget (?:exhausted|exceeded)/i;

const RATE_LIMIT_PATTERN = /rate[ _-]?limit|too many requests|\b429\b|rate_limit_error/i;

/**
 * Finds a usage or rate limit in CLI text and the reset time it gives:
 * `|<epoch seconds>` (Claude's older message), "try again in 2 hours 5
 * minutes", "resets in 30m", "resets at <ISO time>", or an ISO time after
 * "until".
 */
export function detectLimitInText(text: string, now: Date = new Date()): CliLimitInfo | null {
  const usage = USAGE_LIMIT_PATTERN.exec(text);
  const rate = usage ? null : RATE_LIMIT_PATTERN.exec(text);
  const match = usage ?? rate;
  if (!match) return null;
  return {
    kind: usage ? "usage_limit" : "rate_limit",
    resetAt: parseResetTime(text, now),
    message: lineAround(text, match.index).slice(0, 300),
  };
}

export function parseResetTime(text: string, now: Date): string | null {
  const epoch = /\|(\d{10})\b/.exec(text) ?? /"resets?_?[aA]t"\s*:\s*(\d{10})\b/.exec(text);
  if (epoch?.[1]) return new Date(Number(epoch[1]) * 1000).toISOString();

  const iso =
    /(?:resets?(?: at)?|until|after)\s*:?\s*(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))/i.exec(
      text,
    );
  if (iso?.[1]) {
    const date = new Date(iso[1]);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  // Codex: "Try again at 3:15 PM." The time is the machine's local time.
  const clock = /try again at\s+(\d{1,2}):(\d{2})\s*([ap]m)?/i.exec(text);
  if (clock?.[1] && clock[2]) {
    let hours = Number(clock[1]) % 12;
    if (!clock[3]) hours = Number(clock[1]);
    else if (clock[3].toLowerCase() === "pm") hours += 12;
    const at = new Date(now);
    at.setHours(hours, Number(clock[2]), 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at.toISOString();
  }

  const relative =
    /(?:try again in|resets? in|retry in|available in)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i.exec(
      text,
    );
  if (relative?.[1]) {
    const ms = parseDuration(relative[1]);
    if (ms > 0) return new Date(now.getTime() + ms).toISOString();
  }
  return null;
}

function parseDuration(text: string): number {
  const units: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
  let total = 0;
  for (const part of text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const unit = (part[2] ?? "").toLowerCase();
    const key = unit.startsWith("d")
      ? "d"
      : unit.startsWith("h")
        ? "h"
        : unit.startsWith("m")
          ? "m"
          : "s";
    total += Number(part[1]) * (units[key] ?? 0);
  }
  return total;
}

function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? undefined : end).trim();
}

/** The last 500 characters of `text`, trimmed. */
export function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 500 ? `...${trimmed.slice(-500)}` : trimmed;
}

/** Converts epoch seconds to an ISO time, or `null`. */
export function epochToIso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value * 1000).toISOString()
    : null;
}
