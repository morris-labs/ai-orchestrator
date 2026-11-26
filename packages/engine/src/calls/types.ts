// The interface between the agent-call core and the state machine that uses
// it. The core knows leases, tiers, limits, the call cache, events, and the
// working tree guard; everything about the caller's own state, such as a
// review run's roles and rounds, reaches it through `AgentCallHost`.
import type {
  AgentRole,
  BuildStep,
  ModelTier,
  Seat,
  SeatPlacement,
  SpecialtyName,
  Vendor,
} from "@aio/contracts";
import type {
  AdapterMethod,
  AdapterRequest,
  EngineDeps,
  EventDraft,
  LeaseActual,
} from "../core.js";

/** The tier a step chose for a call. */
export interface CallTier {
  tier: ModelTier;
  reason: string;
  /** The caller has a fixed tier, so nothing moves the call up. */
  fixed: boolean;
}

/** One agent call, as a step describes it. */
export interface AgentCallSpec {
  /** The call's tier. Absent when the caller doesn't use tiers. */
  tier?: CallTier;
  /** Cache key, unique in the round. A finished call with this key is not repeated on resume. */
  key: string;
  /**
   * The role the lease and the events name. The core attaches no meaning to
   * it; the caller's `CallRouting` decides what a role may do.
   */
  role: AgentRole;
  vendor: Vendor;
  method: AdapterMethod;
  request: Omit<AdapterRequest, "signal" | "model" | "timeoutMs"> & {
    sessionId?: string;
    timeoutMs?: number;
  };
  groupId: string | null;
  /** Rough size of the call for the lease, in tokens. */
  estimateTokens: number;
  /** Move to another vendor when this one hits its limit. */
  allowFallback?: boolean;
  /**
   * Vendors that must not take this call, such as the finding's reporter for
   * a disprover. A limit fallback skips them, and a server grant that
   * redirects to one stops the call for a decision instead.
   */
  avoid?: readonly Vendor[];
  /** Keep this vendor even when a person assigned the role to another one. */
  pinVendor?: boolean;
  /**
   * The build seat's placement the call runs on. The core copies it onto the
   * call's agent and lease events; `placeCall()` in `build/placements` sets
   * the vendor, tier, and effort to match.
   */
  placement?: SeatPlacement;
  /** The seat a build call fills; the lease and the events name it. */
  seat?: Seat;
  /** The build step a call belongs to; the lease and the events name it. */
  step?: BuildStep;
  /**
   * The specialties of the task a build call works on; the lease and the
   * events name them. `specialtyCall()` in `build/specialties` sets them.
   */
  specialties?: readonly SpecialtyName[];
}

/** The seat, the step, the specialties, and the placement of one call, for its lease and its events. */
export type CallWork = Pick<AgentCallSpec, "seat" | "step" | "specialties" | "placement">;

/**
 * Who a call belongs to: a review run (`runId`), a build (`buildId` with
 * `runId: null`), or a review run that a build started (both).
 */
export interface CallOwner {
  runId: string | null;
  buildId?: string;
}

/** What a finished call returns, and what the call cache holds. */
export interface AgentOutcome<T> {
  vendor: Vendor;
  model: string;
  sessionId: string | null;
  /** The account folder that holds the session; `null` for the CLI's home folder; absent when unknown. */
  accountFolder?: string | null;
  output: T;
  tokens: { in: number; out: number; fresh?: number; cacheWrite?: number; cacheRead?: number };
  /** Tool calls that failed during the call, when the vendor reported any. */
  toolErrors?: string[];
  /** The tier the call ended up using, after any move. */
  tier?: { tier: ModelTier; reason: string };
}

/** A vendor's reported limit: `until` is `null` when only a person can lift it. */
export interface VendorLimit {
  until: string | null;
  message: string;
}

/**
 * The core's saved state. The caller keeps it in its own state file, so ids
 * and limits survive a restart.
 */
export interface CallLedger {
  /** Counters for lease and agent ids, which must stay unique across a resume. */
  counters: { lease: number; agent: number };
  /** Vendors that reported a usage or rate limit; no call goes to them until `until`. */
  limitedVendors: Partial<Record<Vendor, VendorLimit>>;
}

/** An empty ledger for a caller that starts fresh. */
export function newCallLedger(): CallLedger {
  return { counters: { lease: 0, agent: 0 }, limitedVendors: {} };
}

/** Finished calls by key, so a resumed caller doesn't repeat one. */
export interface CallCache {
  read<T>(key: string): Promise<AgentOutcome<T> | null>;
  write<T>(key: string, outcome: AgentOutcome<T>): Promise<void>;
}

/** How the caller shows a wait for a limit, a ceiling, or a person's pause. */
export interface PauseStatus {
  /** True while the caller shows as paused. */
  paused(): boolean;
  /** The end of the timed pause the caller shows, if any. */
  pausedUntil(): string | undefined;
  /** Shows the caller as paused, until `until` or, with none, until a person resumes it. */
  pause(until: string | undefined): Promise<void>;
  /** Shows the caller as running again. */
  resume(): Promise<void>;
}

/** Why a call moved to another vendor. */
export type MoveReason = "ceiling" | "limit";

/** The caller's rules for which vendor and model take a call. */
export interface CallRouting {
  /** The order the core tries vendors in when one hits a limit. */
  readonly fallbackOrder: readonly Vendor[];
  /** True when `vendor` may take a call in `role`. */
  canTake(vendor: Vendor, role: AgentRole): boolean;
  /** True when a limit may move the call to another vendor. */
  movable(spec: AgentCallSpec): boolean;
  /**
   * The vendor a pending call uses after a person's assignment, given the
   * vendor it would use. `limitOf` reports the vendors that hit a limit.
   */
  assigned(spec: AgentCallSpec, vendor: Vendor, limitOf: (v: Vendor) => VendorLimit | null): Vendor;
  /**
   * Records that a call in `role` moved from one vendor to another. With
   * `announce` false, the server already announced the move.
   */
  moved(
    role: AgentRole,
    from: Vendor,
    to: Vendor,
    reason: MoveReason,
    announce: boolean,
  ): Promise<void>;
  /** The model for a call, and a note when the tier has no mapping. */
  model(
    vendor: Vendor,
    tier: ModelTier | undefined,
    role: AgentRole,
  ): { model: string | undefined; note: string | null };
  /** The timeout for a call in `role` that names none. */
  timeoutMs(role: AgentRole): number;
}

/** The state of one call, for a caller that keeps a task list. */
export type CallState = "running" | "done" | "failed" | "skipped";

/** Optional hooks into a call's life, for the caller's own records. */
export interface CallObserver {
  /** A call started, finished, failed, or was skipped. */
  task?(
    spec: AgentCallSpec,
    state: CallState,
    extra: { vendor?: Vendor; effort?: string | undefined },
  ): Promise<void>;
  /** A call is about to request a lease on `vendor`, after routing around limits. */
  leasing?(spec: AgentCallSpec, vendor: Vendor): void;
  /** A call is about to start on `vendor`; the caller's state is saved right after. */
  starting?(spec: AgentCallSpec, vendor: Vendor): void;
  /** A lease was settled with `actual` use. */
  settled?(vendor: Vendor, actual: LeaseActual): void;
}

/** The repository commands the core needs to undo a blocked model's commits. */
export interface CommitUndo {
  head(): Promise<string>;
  resetKeep(sha: string): Promise<void>;
}

/** What the caller gives the core. */
export interface AgentCallHost {
  /**
   * The caller's id: it prefixes lease and agent ids, and it fills `runId` on
   * leases and events unless `owner` says otherwise.
   */
  readonly id: string;
  /**
   * Who the calls belong to, on leases and events. Absent means the review
   * run `id`. A build sets `{ runId: null, buildId }`, which also exempts
   * its calls from the usage ceilings.
   */
  readonly owner?: CallOwner;
  /** The caller's round, for events; a caller without rounds returns 1. */
  round(): number;
  /** The caller's saved ledger. Read on every use, so the caller can swap it. */
  ledger(): CallLedger;
  /** Saves the caller's state, ledger included. */
  persist(): Promise<void>;
  /** Sends an event and records it. */
  emit(draft: EventDraft): Promise<void>;
  status: PauseStatus;
  cache: CallCache;
  routing: CallRouting;
  /**
   * The read-only call guard: `ignore` lists paths calls may write, and
   * `restore` returns a way to reset a worktree that holds only the
   * engine's own files.
   */
  treeGuard: {
    ignore: readonly string[];
    restore?(repoPath: string): (() => Promise<boolean>) | undefined;
  };
  /** Undoes a write call's commits when the call turns out to use a blocked model. */
  commits?: CommitUndo;
  observer?: CallObserver;
}

/** The engine services the core uses. */
export type CallDeps = Pick<
  EngineDeps,
  "adapters" | "broker" | "runner" | "clock" | "ceilings" | "models" | "log"
>;
