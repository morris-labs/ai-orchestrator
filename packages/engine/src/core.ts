// Interfaces between the engine core (W3) and the parts other workstreams
// build: the vendor adapters (W4, `src/adapters`), the lease broker and event
// stream (W5, `src/events`), and the processes the core runs (`git`, `gh`,
// test commands).
//
// The core depends only on these interfaces, so every pipeline test runs with
// fakes. The output schemas below are what each adapter method must return
// after parsing the vendor's reply; the prompts in `src/prompts` ask the
// vendor for exactly these shapes.
import {
  EventSchema,
  VendorFindingSchema,
  type AioEvent,
  type AgentRole,
  type Ceilings,
  type LeaseRequest,
  type LeaseResponse,
  type UsageSample,
  type Vendor,
} from "@aio/contracts";
import { z } from "zod";
import type { EnvProfile } from "./process/env.js";
import type { GitHubClient } from "./postpush/github.js";

// ---------------------------------------------------------------------------
// Processes

/** The result of one finished process. A non-zero exit code is not an error. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the process ran past its timeout and was killed. */
  timedOut: boolean;
  /**
   * True when the program never ran, such as a missing file (`ENOENT`, exit
   * code 127) or one that isn't executable (`EACCES`, exit code 126).
   */
  notStarted?: boolean;
  /** The signal that ended the process, if one did. */
  signal?: string | null;
}

export interface CommandOptions {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /**
   * Which of the engine's variables the process inherits. Absent: the choice
   * of `profileForProgram`: `github` for `gh` and for the git commands that
   * talk to a remote, `untrusted` for everything else.
   */
  envProfile?: EnvProfile;
  /** Written to the process's standard input. */
  input?: string;
  signal?: AbortSignal;
}

/**
 * Runs a program without a shell. `git` and `gh` calls go through this, so a
 * test can script their answers. `src/range/exec.ts` has the real one.
 */
export interface CommandRunner {
  run(program: string, args: readonly string[], options: CommandOptions): Promise<CommandResult>;
}

// ---------------------------------------------------------------------------
// Vendor adapters

/** What the agent may do in the repository. */
export type ToolPolicy = "read-only" | "write";

export interface AdapterRequest {
  /** The full prompt, from `src/prompts`. */
  prompt: string;
  /** The directory the agent works in. */
  repoPath: string;
  /** Extra directories the agent may read, such as the base worktree. */
  extraDirs?: string[];
  /** Directory where the agent may write scratch files even when read-only. */
  scratchDir?: string;
  toolPolicy: ToolPolicy;
  timeoutMs: number;
  /** A model name for the vendor's CLI, or absent for the vendor's default. */
  model?: string;
  /** Aborted when the run is cancelled. The adapter must stop the CLI. */
  signal?: AbortSignal;
}

/** A request that resumes an earlier session of the same vendor. */
export interface ContinueRequest extends AdapterRequest {
  sessionId: string;
}

/** A usage reading before the engine adds the ceiling in force. */
export type RawUsageSample = Omit<UsageSample, "ceiling">;

export interface AdapterResult<T> {
  output: T;
  /** The model that answered, such as `gpt-5` or `claude-opus-4`. */
  model: string;
  /** The vendor session, for `continueReview`; `null` when the CLI has none. */
  sessionId: string | null;
  tokens: { in: number; out: number };
  /** Usage readings the call produced, such as Claude's `rate_limit_event`. */
  usage: RawUsageSample[];
  /** Copilot premium requests; 0 for other vendors. */
  premiumRequests: number;
  /** Copilot AI credits, when the CLI reports them; absent otherwise. */
  aiCredits?: number;
  /** Estimated cost in US dollars. */
  costEstimate: number;
  /**
   * Tool calls that failed during the call, from the vendor's event stream.
   * Absent when the vendor reported none.
   */
  toolErrors?: string[];
}

/** What `detectLimit` reports for an error that a usage or rate limit caused. */
export interface LimitInfo {
  /** When the limit resets, or `null` when the vendor didn't say. */
  resetAt: string | null;
  message: string;
}

const HunkVerdictSchema = z.object({
  hunkId: z.string().min(1),
  /** `findings`: the hunk has at least one finding; `sound`: examined, no issue. */
  verdict: z.enum(["findings", "sound"]),
  /** One line: why the hunk is sound, or which findings it has. */
  reason: z.string(),
});
export type HunkVerdict = z.infer<typeof HunkVerdictSchema>;

/** A reviewer's answer: findings plus a verdict for each hunk it was given. */
export const ReviewOutputSchema = z.object({
  findings: z.array(VendorFindingSchema),
  ledger: z.array(HunkVerdictSchema).default([]),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/** A pattern sweeper's answer: other instances of the confirmed patterns. */
export const SweepOutputSchema = z.object({
  findings: z.array(VendorFindingSchema),
});
export type SweepOutput = z.infer<typeof SweepOutputSchema>;

/**
 * A disprover's answer for one finding. `unverified` means the disprover
 * couldn't check the finding, such as when its tools failed; the finding
 * stays pending and is verified again in the next round.
 */
export const VerifyOutputSchema = z.object({
  verdict: z.enum(["confirmed", "disproved", "unverified"]),
  verification: z.enum(["script", "code-reading"]),
  evidence: z.string(),
  /** Whether the flaw exists in the base worktree too, by the agent's reading. */
  presentAtBase: z.boolean().default(false),
  /**
   * A reproduction script the agent wrote in the scratch directory. It exits
   * 1 when the flaw reproduces and 0 when it doesn't. The engine reruns it at
   * the tip and at the base.
   */
  script: z
    .object({
      /** Path relative to the scratch directory. */
      path: z.string().min(1),
      /** The interpreter, such as `python3` or `bash`; absent runs the file directly. */
      interpreter: z.string().min(1).optional(),
      /**
       * The script's text, for an agent that couldn't write the file. The
       * engine writes it to `path` when the file doesn't exist.
       */
      content: z.string().min(1).optional(),
    })
    .nullable()
    .default(null),
});
export type VerifyOutput = z.infer<typeof VerifyOutputSchema>;

/** The fixer's answer for one batch. The engine reads the commits from git. */
export const FixOutputSchema = z.object({
  fixed: z.array(z.string()),
  notFixed: z.array(z.object({ id: z.string(), reason: z.string() })).default([]),
  summary: z.string().default(""),
});
export type FixOutput = z.infer<typeof FixOutputSchema>;

/** The confirmer's answer: fixes that fall short, and issues the fixes introduced. */
export const ConfirmOutputSchema = z.object({
  incomplete: z.array(z.object({ id: z.string(), reason: z.string() })).default([]),
  findings: z.array(VendorFindingSchema).default([]),
});
export type ConfirmOutput = z.infer<typeof ConfirmOutputSchema>;

/**
 * One vendor's CLI. Every method runs one headless call, enforces
 * `timeoutMs`, parses the reply into the method's output schema, and throws
 * when it can't. `src/adapters/bridge.ts` builds one from each CLI adapter.
 */
export interface VendorAdapter {
  readonly vendor: Vendor;
  review(request: AdapterRequest): Promise<AdapterResult<ReviewOutput>>;
  /** Resumes the reviewer's session with a follow-up prompt. */
  continueReview(request: ContinueRequest): Promise<AdapterResult<ReviewOutput>>;
  verify(request: AdapterRequest): Promise<AdapterResult<VerifyOutput>>;
  fix(request: AdapterRequest): Promise<AdapterResult<FixOutput>>;
  confirm(request: AdapterRequest): Promise<AdapterResult<ConfirmOutput>>;
  sweep(request: AdapterRequest): Promise<AdapterResult<SweepOutput>>;
  /** Returns limit details when `error` came from a usage or rate limit, or `null`. */
  detectLimit(error: unknown): LimitInfo | null;
  /**
   * Whether a failed call is worth its one retry. A sign-in failure or a
   * missing CLI fails the same way twice, so the core stops at once. Absent
   * means every failure that isn't a limit gets its retry.
   */
  isRetryable?(error: unknown): boolean;
}

export type AdapterMethod = "review" | "continueReview" | "verify" | "fix" | "confirm" | "sweep";

export type AdapterSet = Partial<Record<Vendor, VendorAdapter>>;

// ---------------------------------------------------------------------------
// Leases

/** The actual use of a call, reported after it finishes. */
export interface LeaseActual {
  tokens: { in: number; out: number };
  premiumRequests: number;
  /** Copilot AI credits, when the CLI reports them. */
  aiCredits?: number;
  costEstimate: number;
}

/**
 * Asks the server for permission before each model call (see `lease.ts` in
 * the contracts). `EngineLeaseBroker` implements it over the
 * `engine.events` socket. The core emits the `lease.settled` event itself;
 * `settle` only tells the broker the lease is finished.
 */
export interface LeaseBroker {
  /**
   * Asks for a lease. Rejects when `signal` aborts. The response's `leaseId`
   * is the lease to settle, which can differ from the request's.
   */
  acquire(request: LeaseRequest, signal?: AbortSignal): Promise<LeaseResponse>;
  settle(leaseId: string, actual: LeaseActual): void;
}

/** A broker that grants every request on the requested vendor. */
export class GrantingBroker implements LeaseBroker {
  readonly requests: LeaseRequest[] = [];
  readonly settled: Array<{ leaseId: string; actual: LeaseActual }> = [];

  constructor(private readonly clock: Clock = systemClock) {}

  acquire(request: LeaseRequest): Promise<LeaseResponse> {
    this.requests.push(request);
    return Promise.resolve({
      decision: "granted",
      leaseId: request.leaseId,
      vendor: request.vendor,
      redirectedFrom: null,
      expiresAt: new Date(this.clock.now() + 10 * 60_000).toISOString(),
    });
  }

  settle(leaseId: string, actual: LeaseActual): void {
    this.settled.push({ leaseId, actual });
  }
}

// ---------------------------------------------------------------------------
// Events

/** The fields the event stream fills in; the core never sets them. */
export type EventEnvelopeKey = "id" | "time" | "source" | "streamId" | "seq" | "sourceSeq";
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * An event before the stream stamps its id, time, source, and sequence
 * numbers. A `usage.sample` draft names its reading's origin in
 * `sampleSource`, so the stream's `source` never collides with it.
 */
export type EventDraft = DistributiveOmit<AioEvent, EventEnvelopeKey>;

/**
 * Where the core sends events. The engine's `EventHub` implements it: it
 * stamps the base fields, keeps the log for replay, and sends it on
 * `engine.events`. `emit` returns the stamped event, which the run
 * directory's `events.jsonl` keeps.
 */
export interface EventSink {
  emit(draft: EventDraft): AioEvent;
}

/**
 * An in-memory sink that stamps events with increasing sequence numbers and
 * validates each against the contract. Tests and the standalone CLI use it.
 */
export class MemoryEventSink implements EventSink {
  readonly events: AioEvent[] = [];
  private seq = 0;

  constructor(
    readonly source = "engine:local",
    readonly streamId = `stream-${Date.now().toString(36)}`,
    private readonly clock: Clock = systemClock,
  ) {}

  emit(draft: EventDraft): AioEvent {
    this.seq += 1;
    const event = EventSchema.parse({
      ...draft,
      id: `${this.streamId}-${this.seq}`,
      time: new Date(this.clock.now()).toISOString(),
      source: this.source,
      streamId: this.streamId,
      seq: this.seq,
      sourceSeq: this.seq,
    });
    this.events.push(event);
    return event;
  }

  ofType<T extends AioEvent["type"]>(type: T): Array<Extract<AioEvent, { type: T }>> {
    return this.events.filter((e): e is Extract<AioEvent, { type: T }> => e.type === type);
  }
}

// ---------------------------------------------------------------------------
// Time

/** Time source, replaceable in tests so pauses don't wait. */
export interface Clock {
  now(): number;
  /** Resolves after `ms`, or rejects when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

/** A clock that jumps forward instead of waiting. */
export class FakeClock implements Clock {
  constructor(private time = Date.parse("2026-10-28T09:00:00Z")) {}

  now(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
    this.time += Math.max(0, ms);
    return Promise.resolve();
  }

  advance(ms: number): void {
    this.time += ms;
  }
}

// ---------------------------------------------------------------------------
// Everything a run needs from outside the core

export interface RoleTimeouts {
  reviewer: number;
  disprover: number;
  confirmer: number;
  fixer: number;
  sweeper: number;
}

export const DEFAULT_TIMEOUTS: RoleTimeouts = {
  reviewer: 20 * 60_000,
  disprover: 10 * 60_000,
  confirmer: 10 * 60_000,
  fixer: 30 * 60_000,
  sweeper: 10 * 60_000,
};

export interface EngineDeps {
  adapters: AdapterSet;
  broker: LeaseBroker;
  events: EventSink;
  /** Runs `git`, `gh`, and the reproduction scripts. */
  runner: CommandRunner;
  /** Runs the policy's test and lint commands through `sh -c`. Defaults to `runner`. */
  shellRunner?: CommandRunner;
  /** The `gh` client for `base: pr` and the post-push loop. */
  github?: GitHubClient;
  clock?: Clock;
  /** Ceilings attached to usage samples. Defaults to `DEFAULT_CEILINGS`. */
  ceilings?: Ceilings;
  timeouts?: Partial<RoleTimeouts>;
  /** Model per vendor, or absent for each CLI's default. */
  models?: Partial<Record<Vendor, string>>;
  /** Container name for `RunState.container`. */
  container: string;
  /** Where the core reports problems it can't surface on the run, such as a failed write. */
  log?: CoreLog;
}

/** The logger the core writes to; the engine's `Logger` fits it. */
export interface CoreLog {
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Role names the engine requests leases for. */
export type { AgentRole };
