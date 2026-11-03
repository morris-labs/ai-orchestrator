// The interface between the engine API and the engine core.
//
// The API serves a `RunManager`; `src/state/manager.ts` builds one over the
// core's `RunController`s. The event sink and the lease broker the core
// uses are the ones `src/core.ts` defines; the engine's `EventHub` and
// `EngineLeaseBroker` implement them.
import type {
  ApiErrorCode,
  DecisionAnswer,
  RunRetry,
  EngineRunCreate,
  FileGroup,
  Finding,
  Profile,
  Role,
  RoundSummary,
  RunRequest,
  RunState,
  RunStatus,
  Severity,
  TimedUsageSample,
  Vendor,
  Verdict,
} from "@aio/contracts";
import type { AdapterSet, Clock, CommandRunner, EventSink, LeaseBroker } from "../core.js";
import type { GitHubClient } from "../postpush/github.js";

export type { EventDraft, EventEnvelopeKey, EventSink, LeaseBroker } from "../core.js";

// ---------------------------------------------------------------------------
// Errors

/**
 * An error the API turns into an `ApiError` body. The core throws it (or any
 * error with a `code` from `ApiErrorCode`) when a request can't be served.
 */
export class EngineError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

// ---------------------------------------------------------------------------
// Runs

export interface RunListFilter {
  projectId?: string;
  boxId?: string;
  status?: RunStatus;
}

export interface FindingFilter {
  verdict?: Verdict;
  severity?: Severity;
  round?: number;
}

export interface UsageFilter {
  vendor?: Vendor;
  since?: string;
  until?: string;
}

/** The body of `runs.preview`. */
export interface RunPreview {
  baseSha: string;
  tipSha: string;
  diffBaseSha: string;
  groups: FileGroup[];
  changedLines: number;
  dirty: boolean;
  tokenEstimate?: { tokens: number; basis: string };
  excluded?: { count: number; files: { path: string; source: "built-in" | "policy" | "run" }[] };
}

export interface FindingDetail {
  finding: Finding;
  diff: string | null;
  fixDiff: string | null;
}

/**
 * The engine core. Every method that names a run throws `EngineError` with
 * `run_not_found` for an unknown run and `invalid_state` when the run's
 * status doesn't allow the action, except `get`, `finding`, which return
 * `null` for an unknown run or finding.
 */
export interface RunManager {
  list(filter: RunListFilter): Promise<RunState[]>;
  preview(request: RunRequest): Promise<RunPreview>;
  /** Starts a run under the server-minted id. Throws `dirty_tree` or `conflict`. */
  start(request: EngineRunCreate): Promise<RunState>;
  get(runId: string): Promise<RunState | null>;
  pause(runId: string): Promise<RunState>;
  resume(runId: string): Promise<RunState>;
  cancel(runId: string): Promise<RunState>;
  profile(runId: string, profile: Profile): Promise<RunState>;
  assign(runId: string, role: Role, vendors: Vendor[]): Promise<RunState>;
  rebaseBase(runId: string): Promise<RunState>;
  retry(runId: string, options: RunRetry): Promise<RunState>;
  decide(runId: string, answer: DecisionAnswer): Promise<RunState>;
  push(runId: string, options: { title?: string; draft: boolean }): Promise<RunState>;
  groups(runId: string): Promise<FileGroup[]>;
  rounds(runId: string): Promise<RoundSummary[]>;
  findings(runId: string, filter: FindingFilter): Promise<Finding[]>;
  finding(runId: string, findingId: string): Promise<FindingDetail | null>;
  waive(runId: string, findingId: string, reason: string): Promise<Finding>;
  usageSamples(filter: UsageFilter): Promise<TimedUsageSample[]>;
  /**
   * The number of runs that keep the container alive: pending, running,
   * paused, or waiting for a decision.
   */
  activeRunCount(): number;
  /**
   * Stops work and flushes run files; called once on shutdown, just before
   * the lease broker closes. It must mark the runs as stopping before its
   * first `await`, so a closed broker doesn't fail them.
   */
  close?(): Promise<void>;
}

/** What `createRunManager()` receives. */
export interface CoreDeps {
  projectRoot: string;
  container: string;
  events: EventSink;
  leases: LeaseBroker;
  /** One adapter per vendor the engine can call. */
  adapters: AdapterSet;
  log: Logger;
  /** Runs `git`, `gh`, and reproduction scripts. Defaults to `ExecaRunner`. */
  runner?: CommandRunner;
  /** The `gh` client for `base: pr` and pushes. Defaults to `GhCliClient` over `runner`. */
  github?: GitHubClient;
  clock?: Clock;
  /** Model per vendor; absent leaves each CLI's default. */
  models?: Partial<Record<Vendor, string>>;
  /** The policy file, relative to the project root or absolute. */
  policyPath?: string;
}

/** Statuses that count as active for the keeper. */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  "pending",
  "running",
  "paused",
  "waiting_decision",
];

// ---------------------------------------------------------------------------
// Logging

export type LogLevel = "debug" | "info" | "warn" | "error";

/** A small structured logger. Never pass a token or a secret in `fields`. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
