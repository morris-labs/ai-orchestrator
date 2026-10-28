// The interfaces between the engine service (W5) and the engine core (W3).
//
// The core (`src/core.ts`) exposes a `RunManager`. The service hands the core
// an `EventSink` to publish events on the engine's stream and a
// `LeaseBroker` to ask the server for usage leases. Both sides code against
// these types only, so each can be tested with fakes of the other.
import type {
  AgentBoxEvent,
  ApiErrorCode,
  DecisionAnswer,
  EngineRunCreate,
  FileGroup,
  Finding,
  LeaseRequest,
  LeaseResponse,
  LeaseSettlement,
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
} from "@agentbox/contracts";

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
// Events

/** The fields the event stream fills in; the core never sets them. */
export type EventEnvelopeKey = "id" | "time" | "source" | "streamId" | "seq" | "sourceSeq";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event as the core emits it, before the stream numbers it. */
export type EventDraft = DistributiveOmit<AgentBoxEvent, EventEnvelopeKey>;

/** Where the core publishes events. */
export interface EventSink {
  /** Validates, numbers, stores, and broadcasts an event. Returns the full event. */
  emit(draft: EventDraft): AgentBoxEvent;
}

// ---------------------------------------------------------------------------
// Leases

/** What the core asks for; the broker assigns `leaseId` when it's absent. */
export type LeaseAsk = Omit<LeaseRequest, "leaseId"> & { leaseId?: string };

export type LeaseGrant = Extract<LeaseResponse, { decision: "granted" }>;

/**
 * The engine side of the lease protocol in `lease.ts`. The core calls
 * `request()` before each model call and `settle()` after it.
 */
export interface LeaseBroker {
  /**
   * Sends a `lease.request` frame and resolves with the server's answer. The
   * request waits while no server is subscribed. A grant that has already
   * expired when it arrives is asked for again under a new lease id. Rejects
   * when `signal` aborts or the broker closes.
   */
  request(ask: LeaseAsk, options?: { signal?: AbortSignal }): Promise<LeaseResponse>;
  /** True while a grant can still start a call: before its `expiresAt`. */
  isUsable(grant: LeaseGrant): boolean;
  /** Emits a `lease.settled` event with the call's actual usage. */
  settle(settlement: LeaseSettlement): void;
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
  /** Stops work and flushes run files; called once on shutdown. */
  close?(): Promise<void>;
}

/** What `src/core.ts` receives to build a `RunManager`. */
export interface CoreDeps {
  projectRoot: string;
  container: string;
  events: EventSink;
  leases: LeaseBroker;
  log: Logger;
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
