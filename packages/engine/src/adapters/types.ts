// The CLI adapter interface: one headless call to a vendor's CLI with any
// output schema. The engine core talks to vendors through its own
// `VendorAdapter` in `src/core.ts`; `bridge.ts` turns a `CliVendorAdapter`
// into one.
import type { AgentRole, Effort, UsageSample, Vendor } from "@aio/contracts";
import type { z } from "zod";
import type { AdapterMethod, LimitInfo } from "../core.js";

/** What the agent may do to the working tree. */
export type ToolAccess = "read-only" | "write";

/** One model call. */
export interface CliRequest<T = unknown> {
  /** The user prompt. Adapters pass it on stdin where the CLI allows it. */
  prompt: string;
  /** Extra instructions; appended to the CLI's own system prompt where it has one. */
  systemPrompt?: string;
  /** The directory the CLI runs in, normally the run's worktree. */
  cwd: string;
  /**
   * Directories outside `cwd` the agent may use, such as the base worktree or
   * a scratch directory. Adapters whose CLI takes `--add-dir` pass each one.
   */
  addDirs?: string[];
  /**
   * A directory a read-only agent may write to, such as the disprover's
   * scratch directory. The repository stays read-only. Each adapter grants
   * it the way its CLI allows (see the vendor assumption docs).
   */
  scratchDir?: string;
  tools: ToolAccess;
  /** A model name or alias. Absent means the CLI's default (automatic for Copilot). */
  model?: string;
  effort?: Effort;
  /** The call is killed after this many milliseconds. */
  timeoutMs: number;
  /** A session to continue. `continueReview` requires it. */
  sessionId?: string;
  /** Validates the structured output. */
  outputSchema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** A JSON Schema for the CLI. Absent means the adapter derives one from `outputSchema`. */
  jsonSchema?: Record<string, unknown>;
  /** Claude only: the most the call may spend, in US dollars. */
  maxBudgetUsd?: number;
  /** Claude only: the most agent turns the call may take. */
  maxTurns?: number;
  /** Cancels the call; the process is killed. */
  signal?: AbortSignal;
  /** Called for each usage sample as it arrives, before the call ends. */
  onUsage?: (sample: UsageSample) => void;
  /** The account folder of this call, which the adapter's `dispatch` sets once. */
  accountFolder?: string | undefined;
}

export interface TokenCounts {
  input: number;
  output: number;
}

/** The result of a successful call. */
export interface CliResult<T = unknown> {
  output: T;
  /** The session to pass back for a continuation; `null` when the CLI reported none. */
  sessionId: string | null;
  /** The model that answered, when the CLI says; otherwise the requested model or `null`. */
  model: string | null;
  usage: UsageSample[];
  tokens: TokenCounts;
  /** The CLI's own cost figure in US dollars, when it reports one. */
  costUsd?: number;
  /** Copilot premium requests; 0 for other vendors. */
  premiumRequests: number;
  /** Copilot AI credits, when the CLI reports them. */
  aiCredits?: number;
  /** The CLI's stdout, for the run directory. */
  raw: string;
  durationMs: number;
  /**
   * Tool calls that failed during the call, as the CLI's event stream
   * reported them: a command that exited nonzero, one the sandbox refused, or
   * a tool that returned an error. Absent when the CLI reports none.
   */
  toolErrors?: string[];
}

/** A usage or rate limit a vendor reported: the core's `LimitInfo` plus its kind. */
export interface CliLimitInfo extends LimitInfo {
  /** `usage_limit` is a plan window or budget running out; `rate_limit` is a short throttle. */
  kind: "usage_limit" | "rate_limit";
}

export type AdapterErrorKind =
  | "limit"
  | "auth"
  | "timeout"
  | "cancelled"
  | "output"
  | "process"
  | "unavailable"
  | "blocked_model";

/** The one error type adapters throw. */
export class AdapterError extends Error {
  readonly kind: AdapterErrorKind;
  readonly vendor: Vendor;
  readonly limit: CliLimitInfo | null;
  readonly exitCode: number | null;
  readonly raw: string;
  readonly sessionId: string | null;
  /** Usage samples the call reported before it failed. The bridge fills this in. */
  usage: UsageSample[] = [];

  constructor(
    vendor: Vendor,
    kind: AdapterErrorKind,
    message: string,
    extra: {
      limit?: CliLimitInfo | null;
      exitCode?: number | null;
      raw?: string;
      sessionId?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = "AdapterError";
    this.vendor = vendor;
    this.kind = kind;
    this.limit = extra.limit ?? null;
    this.exitCode = extra.exitCode ?? null;
    this.raw = extra.raw ?? "";
    this.sessionId = extra.sessionId ?? null;
  }
}

/** The result of `health()`. */
export interface AdapterHealth {
  vendor: Vendor;
  /** True when the CLI runs and prints a version. It doesn't prove the CLI is signed in. */
  available: boolean;
  version: string | null;
  error: string | null;
}

/** The calls the pipeline makes. Each method maps to an `AgentRole`. */
export interface CliVendorAdapter {
  readonly vendor: Vendor;
  /** A fresh finder. */
  review<T>(req: CliRequest<T>): Promise<CliResult<T>>;
  /** Resumes a finder's session and asks for more findings. Needs `sessionId`. */
  continueReview<T>(req: CliRequest<T> & { sessionId: string }): Promise<CliResult<T>>;
  /** The disprover. */
  verify<T>(req: CliRequest<T>): Promise<CliResult<T>>;
  /** The fixer; normally with `tools: "write"`. */
  fix<T>(req: CliRequest<T>): Promise<CliResult<T>>;
  /** The fix confirmer. */
  confirm<T>(req: CliRequest<T>): Promise<CliResult<T>>;
  /** The pattern sweep's cheap agent. */
  sweep<T>(req: CliRequest<T>): Promise<CliResult<T>>;
  /** Returns the limit an error reports, or `null` when it isn't a limit. */
  detectLimit(error: unknown): CliLimitInfo | null;
  health(): Promise<AdapterHealth>;
}

/** The agent role behind each adapter method, for leases and events. */
export const METHOD_ROLES = {
  review: "reviewer",
  continueReview: "reviewer",
  verify: "disprover",
  fix: "fixer",
  confirm: "confirmer",
  sweep: "sweeper",
} as const satisfies Record<AdapterMethod, AgentRole>;

export type { AdapterMethod };
