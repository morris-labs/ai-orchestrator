// The live context of one run: its state files, events, leases, agent calls,
// and the pause, resume, and cancel controls. The pre-push and post-push
// drivers build on it.
import {
  BLOCKED_DEFAULT_FALLBACK,
  DEFAULT_CEILINGS,
  DEFAULT_TIER_MODELS,
  blockedModelMessage,
  isBlockedReviewModel,
  type Effort,
  type ModelTier,
  type Actor,
  type AgentRole,
  type Decision,
  type Finding,
  type PolicyFile,
  type Role,
  type RoundSummary,
  type RunState,
  type RunStatus,
  type Stage,
  type Verdict,
  type Vendor,
  type UsageSample,
  isBlockedRequestedModel,
  VENDOR_ROLES,
} from "@aio/contracts";
import {
  DEFAULT_TIMEOUTS,
  systemClock,
  type AdapterMethod,
  type AdapterRequest,
  type AdapterResult,
  type Clock,
  type CommandRunner,
  type EngineDeps,
  type EventDraft,
  type LeaseActual,
  type LimitInfo,
  type RoleTimeouts,
  type VendorAdapter,
} from "../core.js";
import { NO_EXTRAS, type PolicyExtras } from "../policy/load.js";
import { Git } from "../range/git.js";
import { ShellRunner } from "../range/exec.js";
import type { EngineState } from "../run/engine-state.js";
import type { RunStore } from "../run/store.js";
import { EngineCheckout, readOnlyCheckoutPath } from "./checkout.js";
import { TreeGuard } from "./tree-guard.js";
import { FALLBACK_ORDER } from "../verify/verify.js";
import { assignRoles } from "./profiles.js";
import type { RangeInfo } from "../prompts/templates.js";

/** Thrown inside a stage to stop the run and wait for a person. */
export class DecisionNeeded extends Error {
  constructor(readonly decision: Decision) {
    super(decision.message);
    this.name = "DecisionNeeded";
  }
}

/** Thrown when the run is cancelled. */
export class RunCancelled extends Error {
  constructor() {
    super("The run was cancelled.");
    this.name = "RunCancelled";
  }
}

/** Thrown when an agent call failed twice; the run stops with a report. */
export class AgentFailed extends Error {
  constructor(
    readonly role: AgentRole,
    readonly vendor: Vendor,
    message: string,
  ) {
    super(message);
    this.name = "AgentFailed";
  }
}

/** A vendor's safety filter refused the request. Repeating the call gets the same answer. */
const SAFETY_REFUSAL = /flagged for possible cybersecurity risk|cyber permissive safeguards/i;

/** Thrown when a vendor's safety filter refused a call. */
export class SafetyRefused extends AgentFailed {
  constructor(role: AgentRole, vendor: Vendor, message: string) {
    super(role, vendor, message);
    this.name = "SafetyRefused";
  }
}

/** Thrown when the server denied a lease with `fail_role`. */
export class RoleDenied extends Error {
  constructor(
    readonly role: AgentRole,
    readonly vendor: Vendor,
    reason: string,
  ) {
    super(`The server refused a ${role} call on ${vendor}: ${reason}`);
    this.name = "RoleDenied";
  }
}

class CallTimeout extends Error {
  constructor(ms: number) {
    super(`The agent call ran past its ${Math.round(ms / 1000)} second timeout.`);
    this.name = "CallTimeout";
  }
}

/** The tier a step chose for a call. */
export interface CallTier {
  tier: ModelTier;
  reason: string;
  /** The run has a fixed tier, so nothing moves the call up. */
  fixed: boolean;
}

/** True for a vendor's answer that didn't match the output schema. */
function isMalformedOutput(error: unknown): boolean {
  return (error as { kind?: unknown } | null)?.kind === "output";
}

export interface AgentCallSpec {
  /** The call's tier. Absent when the run doesn't use tiers. */
  tier?: CallTier;
  /** Cache key, unique in the round. A finished call with this key is not repeated on resume. */
  key: string;
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
  /** Move to another vendor when this one hits its limit. The fixer never moves. */
  allowFallback?: boolean;
  /**
   * Vendors that must not take this call: the finding's reporter for a
   * disprover, the fixer for a confirmer. A limit fallback skips them, and a
   * server grant that redirects to one stops the run for a decision instead.
   */
  avoid?: readonly Vendor[];
  /** Keep this vendor even when a person assigned the role to another one. */
  pinVendor?: boolean;
}

export interface AgentOutcome<T> {
  vendor: Vendor;
  model: string;
  sessionId: string | null;
  output: T;
  tokens: { in: number; out: number };
  /** Tool calls that failed during the call, when the vendor reported any. */
  toolErrors?: string[];
  /** The tier the call ended up using, after any move. */
  tier?: { tier: ModelTier; reason: string };
}

/** How often a run waiting out a ceiling asks the server again. */
const LEASE_RECHECK_MS = 60_000;

/** How long a rate limit with no usable reset time keeps a vendor out of the run. */
const RATE_LIMIT_BLOCK_MS = 15 * 60_000;

/** The shortest block after a limit, so a reset time in the past can't make a tight loop. */
const MIN_LIMIT_BLOCK_MS = 60_000;

/** The longest single sleep: a longer timer fires at once. */
const MAX_SLEEP_MS = 2_000_000_000;

/**
 * Vendors whose review calls take a reasoning effort. Copilot's automatic model
 * selection isn't known to honor one, so a call to it uses Copilot's default.
 */
const EFFORT_VENDORS: readonly Vendor[] = ["claude", "codex"];

const ROLE_FOR_AGENT: Record<AgentRole, Role> = {
  reviewer: "reviewer",
  disprover: "disprover",
  confirmer: "confirmer",
  fixer: "fixer",
  sweeper: "reviewer",
};

const ZERO_USE: LeaseActual = { tokens: { in: 0, out: 0 }, premiumRequests: 0, costEstimate: 0 };

const TERMINAL: readonly RunStatus[] = ["finished", "failed", "cancelled"];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL.includes(status);
}

export class RunContext {
  readonly clock: Clock;
  readonly git: Git;
  readonly shell: CommandRunner;
  readonly timeouts: RoleTimeouts;
  private abort = new AbortController();
  /** Ends the waits of pauses for a usage limit early; parallel calls wait separately. */
  private readonly pauseWakes = new Set<AbortController>();
  /** Agent calls in progress, including ones that outlive a stopped driver. */
  private readonly calls = new Set<Promise<unknown>>();
  /** True from when the driver stops until the next one starts: leftover calls start nothing. */
  private stopped = false;
  private pauseRequested = false;
  private cancelRequested = false;
  /** Every parallel call waits on the same gate while the run is paused. */
  private pauseGate: { promise: Promise<void>; open: () => void } | null = null;
  /** Engine-only policy settings, such as the comment authors to trust. */
  extras: PolicyExtras = NO_EXTRAS;
  /** Checks that read-only calls leave their worktree as they found it, one guard per worktree. */
  private readonly treeGuards = new Map<string, TreeGuard>();
  /**
   * The engine-owned checkout that read-only calls run in (see
   * `checkout.ts`). Steps move it with `readOnlyRepo()` in `steps.ts`.
   */
  readonly readOnlyCheckout: EngineCheckout;
  /** Serializes writes, since parallel agent calls update the same files. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    public state: RunState,
    public eng: EngineState,
    public findings: Finding[],
    readonly store: RunStore,
    readonly deps: EngineDeps,
    public policy: PolicyFile,
  ) {
    this.clock = deps.clock ?? systemClock;
    this.git = new Git(deps.runner, state.request.repoPath);
    this.shell = deps.shellRunner ?? new ShellRunner(deps.runner);
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
    this.readOnlyCheckout = new EngineCheckout(this.git, readOnlyCheckoutPath(state.id));
  }

  /**
   * The guard for read-only calls in `repoPath`. Only the engine's own
   * checkout gets restored after a call changed it; any other worktree,
   * such as the checkout under review, is only reported.
   */
  private treeGuardFor(repoPath: string): TreeGuard {
    let guard = this.treeGuards.get(repoPath);
    if (!guard) {
      const checkout = this.readOnlyCheckout;
      guard = new TreeGuard({
        runner: this.deps.runner,
        repoPath,
        ignore: [this.store.dir],
        ...(repoPath === checkout.dir ? { restore: () => checkout.reset() } : {}),
      });
      this.treeGuards.set(repoPath, guard);
    }
    return guard;
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get round(): number {
    return this.state.round;
  }

  /** Vendors this engine has an adapter for: a CLI that answered, or a mock. */
  get availableVendors(): Vendor[] {
    return (["claude", "codex", "copilot"] as const).filter((v) => this.usable(v));
  }

  /** True when this engine has an adapter for `vendor`. */
  usable(vendor: Vendor): boolean {
    return this.deps.adapters[vendor] !== undefined;
  }

  /**
   * The model for a call on `vendor` at `tier`, and a note when the vendor
   * has no mapping. Every model a call uses comes from here.
   */
  private chooseModel(
    vendor: Vendor,
    tier: ModelTier | undefined,
    role?: AgentRole,
  ): { model: string | undefined; note: string | null } {
    const existing = this.deps.models?.[vendor] ?? BLOCKED_DEFAULT_FALLBACK[vendor];
    if (!tier) return { model: existing, note: null };
    // A large confirmer reads the round's whole fix diff, so a policy that lowers
    // the large tier for per-group calls doesn't lower it.
    const builtIn = DEFAULT_TIER_MODELS[vendor]?.[tier];
    const mapped =
      role === "confirmer" && tier === "large" && builtIn
        ? builtIn
        : (this.policy.tierModels?.[vendor]?.[tier] ?? builtIn);
    if (mapped) return { model: mapped, note: null };
    return {
      model: existing,
      note: `${vendor} has no mapping for the ${tier} tier, so the call uses ${existing ?? "the CLI's default model"}`,
    };
  }

  /** The run's range. `repoPath` overrides the repository path, such as for a read-only checkout. */
  range(repoPath: string = this.state.request.repoPath): RangeInfo {
    return {
      repoPath,
      baseSha: this.state.baseSha ?? "",
      tipSha: this.state.tipSha ?? "",
      tipRef: this.eng.tipRef,
    };
  }

  nowIso(): string {
    return new Date(this.clock.now()).toISOString();
  }

  // -------------------------------------------------------------------------
  // Persistence and events

  /**
   * Queues a write behind the earlier ones. The caller sees its own write's
   * failure; the queue doesn't, so one failed write never blocks the next.
   */
  private enqueue(write: () => Promise<void>): Promise<void> {
    const done = this.writeChain.then(write);
    this.writeChain = done.catch(() => undefined);
    return done;
  }

  /** Writes state.json, engine.json, and findings.json. */
  persist(): Promise<void> {
    this.state.updatedAt = this.nowIso();
    const state = structuredClone(this.state);
    const eng = structuredClone(this.eng);
    const findings = structuredClone(this.findings);
    return this.enqueue(async () => {
      await this.store.saveState(state);
      await this.store.saveEngineState(eng);
      await this.store.saveFindings(findings);
    });
  }

  /** Sends an event, then appends it to `events.jsonl`. The event goes out even when the write fails. */
  async emit(draft: EventDraft): Promise<void> {
    const event = this.deps.events.emit(draft);
    await this.enqueue(() => this.store.appendEvent(event));
  }

  async emitRun(roundSummary: RoundSummary | null = null): Promise<void> {
    await this.emit({ type: "run.changed", run: structuredClone(this.state), roundSummary });
  }

  async setStage(stage: Stage): Promise<void> {
    const previous = this.state.stage;
    if (previous === stage) return;
    this.state.stage = stage;
    await this.persist();
    await this.emit({
      type: "stage.changed",
      runId: this.state.id,
      round: this.round,
      stage,
      previousStage: previous,
    });
  }

  async setStatus(status: RunStatus, patch: Partial<RunState> = {}): Promise<void> {
    Object.assign(this.state, patch, { status });
    if (isTerminal(status)) this.state.finishedAt = this.nowIso();
    await this.persist();
    await this.emitRun();
  }

  /**
   * Sets a final status and announces it, even when the run directory can't
   * be written: a write failure is logged, and the `run.changed` event still
   * goes out. Never rejects.
   */
  async settleStatus(status: RunStatus, patch: Partial<RunState> = {}): Promise<void> {
    Object.assign(this.state, patch, { status });
    if (isTerminal(status)) this.state.finishedAt = this.nowIso();
    try {
      await this.persist();
    } catch (error) {
      this.deps.log?.error("Couldn't write the run's state", {
        runId: this.state.id,
        status,
        error: String(error),
      });
    }
    try {
      await this.emitRun();
    } catch (error) {
      this.deps.log?.error("Couldn't record the run's status change", {
        runId: this.state.id,
        status,
        error: String(error),
      });
    }
  }

  async handoff(
    from: { stage: Stage; vendor?: Vendor | null; role?: AgentRole | null },
    to: { stage: Stage; vendor?: Vendor | null; role?: AgentRole | null },
    artifact: string,
    count: number,
    file: string | null,
  ): Promise<void> {
    await this.emit({
      type: "handoff",
      runId: this.state.id,
      round: this.round,
      from: { stage: from.stage, vendor: from.vendor ?? null, role: from.role ?? null },
      to: { stage: to.stage, vendor: to.vendor ?? null, role: to.role ?? null },
      artifact,
      count,
      file,
    });
  }

  nextFindingId(): string {
    this.eng.counters.finding += 1;
    return `F-${String(this.eng.counters.finding).padStart(4, "0")}`;
  }

  findingById(id: string): Finding | undefined {
    return this.findings.find((f) => f.id === id);
  }

  /** Changes a finding's verdict, adds the history entry, and emits `finding.changed`. */
  async setVerdict(
    finding: Finding,
    verdict: Verdict,
    actor: Actor,
    evidence: string,
    patch: Partial<Finding> = {},
  ): Promise<void> {
    const previous = finding.verdict;
    Object.assign(finding, patch, { verdict });
    if (evidence) finding.evidence = evidence;
    finding.history.push({
      time: this.nowIso(),
      verdict,
      actor,
      evidence: evidence || undefined,
      round: Math.max(1, this.round),
    });
    await this.persist();
    await this.emit({
      type: "finding.changed",
      runId: this.state.id,
      finding: structuredClone(finding),
      previousVerdict: previous,
    });
  }

  /** Emits `finding.changed` for a finding that the merge just created. */
  async announceFinding(finding: Finding): Promise<void> {
    await this.emit({
      type: "finding.changed",
      runId: this.state.id,
      finding: structuredClone(finding),
      previousVerdict: null,
    });
  }

  // -------------------------------------------------------------------------
  // Controls

  requestPause(): void {
    this.pauseRequested = true;
  }

  requestResume(): void {
    this.pauseRequested = false;
    const gate = this.pauseGate;
    this.pauseGate = null;
    gate?.open();
  }

  requestCancel(): void {
    this.cancelRequested = true;
    this.abort.abort(new RunCancelled());
    this.requestResume();
  }

  get cancelled(): boolean {
    return this.cancelRequested;
  }

  /** Called between agent calls: honors a pause or a cancel. */
  async checkpoint(): Promise<void> {
    this.throwIfStopped();
    if (this.cancelRequested) throw new RunCancelled();
    if (!this.pauseRequested) return;
    let gate = this.pauseGate;
    if (!gate) {
      let open = () => undefined as void;
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      gate = { promise, open };
      this.pauseGate = gate;
      await this.setStatus("paused");
    }
    await gate.promise;
    this.throwIfStopped();
    if (this.cancelRequested) throw new RunCancelled();
    if (this.state.status === "paused") await this.setStatus("running", { pausedUntil: undefined });
  }

  /** Pauses the run until `until` (ISO time), as a ceiling or a limit asks. */
  async pauseUntil(until: string): Promise<void> {
    this.throwIfStopped();
    await this.setStatus("paused", { pausedUntil: until });
    await this.waitOut(Date.parse(until) - this.clock.now());
    await this.endPause();
  }

  private async endPause(): Promise<void> {
    this.throwIfStopped();
    if (this.cancelRequested) throw new RunCancelled();
    this.state.pausedUntil = undefined;
    await this.setStatus("running");
  }

  /** Waits for `ms`, or until a person wakes the pause. */
  private async waitOut(ms: number): Promise<void> {
    if (ms <= 0) return;
    const wake = new AbortController();
    this.pauseWakes.add(wake);
    const onCancel = () => wake.abort();
    this.signal.addEventListener("abort", onCancel, { once: true });
    try {
      await this.clock.sleep(Math.min(ms, MAX_SLEEP_MS), wake.signal);
    } catch {
      if (this.signal.aborted) throw new RunCancelled();
    } finally {
      this.signal.removeEventListener("abort", onCancel);
      this.pauseWakes.delete(wake);
    }
  }

  /** Ends every wait for a usage limit now, such as after a person resumes the run. */
  wakePause(): void {
    for (const wake of this.pauseWakes) wake.abort();
  }

  /**
   * Marks the driver as stopped. Parallel calls that outlive it can finish a
   * CLI call that is under way, since its answer is paid for, but they start
   * nothing, wait for nothing, and change no status or role.
   */
  stopCalls(): void {
    this.stopped = true;
    this.requestResume();
    this.wakePause();
  }

  /** Stops what is left of the last driver's calls, then lets calls start again. */
  async beginDrive(): Promise<void> {
    if (this.calls.size > 0) {
      this.stopped = true;
      this.abort.abort(new RunCancelled());
      await Promise.allSettled([...this.calls]);
    }
    if (this.abort.signal.aborted && !this.cancelRequested) this.abort = new AbortController();
    this.stopped = false;
  }

  private throwIfStopped(): void {
    if (this.stopped) throw new RunCancelled();
  }

  /** Forgets the limits vendors reported. A person acted, so the next call finds out afresh. */
  clearVendorLimits(): void {
    this.eng.limitedVendors = {};
  }

  /** The vendor's limit in this run, or `null` when it has none or it passed. */
  private limitOf(vendor: Vendor): { until: string | null; message: string } | null {
    const limit = this.eng.limitedVendors[vendor];
    if (!limit) return null;
    if (limit.until !== null && Date.parse(limit.until) <= this.clock.now()) {
      delete this.eng.limitedVendors[vendor];
      return null;
    }
    return limit;
  }

  /** Records a limit. A quota with no reset time blocks the vendor until a person acts. */
  private noteLimit(vendor: Vendor, limit: LimitInfo): void {
    const now = this.clock.now();
    const reset = limit.resetAt ? Date.parse(limit.resetAt) : Number.NaN;
    let until: number | null;
    if (!Number.isNaN(reset) && reset > now) until = Math.max(reset, now + MIN_LIMIT_BLOCK_MS);
    else if (limit.kind === "rate_limit" || !Number.isNaN(reset)) until = now + RATE_LIMIT_BLOCK_MS;
    else until = null;
    this.eng.limitedVendors[vendor] = {
      until: until === null ? null : new Date(until).toISOString(),
      message: limit.message,
    };
  }

  /**
   * The vendor a call may use given the limits seen in this run. It moves the
   * call to another vendor that can take the role. With none, it pauses until
   * the first known reset, or asks a person when no reset time is known, so
   * no call goes to a vendor that just reported a limit.
   */
  private async routeAroundLimits(spec: AgentCallSpec, start: Vendor): Promise<Vendor> {
    let vendor = start;
    for (;;) {
      await this.checkpoint();
      vendor = this.assignedVendor(spec, vendor);
      const limit = this.limitOf(vendor);
      if (!limit) return vendor;
      const movable =
        spec.allowFallback !== false && spec.role !== "fixer" && spec.method !== "continueReview";
      if (movable) {
        const next = this.fallbackVendor(spec.role, spec.avoid);
        if (next) {
          await this.reassign(spec.role, vendor, next, "limit");
          return next;
        }
      }
      const others = movable
        ? FALLBACK_ORDER.filter(
            (v) =>
              v !== vendor &&
              VENDOR_ROLES[v].includes(spec.role) &&
              !spec.avoid?.includes(v) &&
              this.usable(v),
          )
        : [];
      const resets = [vendor, ...others].flatMap((v) => this.limitOf(v)?.until ?? []);
      if (resets.length === 0) {
        throw new DecisionNeeded({
          kind: "ceiling",
          findingIds: [],
          options: ["resume", "cancel"],
          message: `${vendor} reported a limit with no reset time: ${limit.message}. No other usable vendor can take the ${spec.role} call. Assign the role to another vendor, or resume when ${vendor} has room again.`,
        });
      }
      const earliest = resets.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
      await this.pauseUntil(earliest);
    }
  }

  /**
   * Gives a role to vendors for the rest of this round too: calls that haven't
   * started move, including one waiting out a ceiling. A later assignment of
   * the same role replaces a queued one.
   */
  async assignNow(role: Role, vendors: Vendor[]): Promise<void> {
    this.eng.pendingAssign = this.eng.pendingAssign.filter((a) => a.role !== role);
    this.eng.pendingAssign.push({ role, vendors });
    if (role === "reviewer") this.eng.manualRoles.reviewer = vendors;
    else this.eng.manualRoles[role] = vendors[0] as Vendor;
    // Naming a vendor overrides what the run remembers about its limit.
    for (const v of vendors) delete this.eng.limitedVendors[v];
    await this.refreshRoles([role]);
    this.wakePause();
  }

  /**
   * Works out the roles again from the profile and the manual roles, which
   * drops any move a limit made, and announces the changes to `roles`.
   */
  async refreshRoles(
    roles: readonly Role[] = ["reviewer", "disprover", "confirmer", "fixer"],
  ): Promise<void> {
    const before = this.state.roles;
    const after = assignRoles({
      profile: this.state.profile,
      round: Math.max(this.round, 1),
      available: this.availableVendors,
      manual: this.eng.manualRoles,
      alternating: this.eng.alternating,
      crossVendor: this.state.request.crossVendor,
    });
    this.state.roles = after;
    await this.persist();
    for (const role of roles) {
      const from = role === "reviewer" ? before.reviewer : [before[role]];
      const to = role === "reviewer" ? after.reviewer : [after[role]];
      if (from.join() === to.join()) continue;
      await this.emit({
        type: "role.reassigned",
        runId: this.state.id,
        role,
        from,
        to,
        reason: "manual",
        effectiveRound: Math.max(this.round, 1),
      });
    }
  }

  /**
   * The vendor a pending call uses after a person's assignment: the assigned
   * vendor, unless the call may not use it or it reported a limit. A
   * continuation stays with the vendor that holds its session.
   */
  private assignedVendor(spec: AgentCallSpec, vendor: Vendor): Vendor {
    if (spec.pinVendor || spec.method === "continueReview" || spec.role === "sweeper")
      return vendor;
    const role = ROLE_FOR_AGENT[spec.role];
    const manual = this.eng.manualRoles[role];
    if (manual === undefined) return vendor;
    const assigned = Array.isArray(manual) ? manual : [manual];
    if (assigned.includes(vendor)) return vendor;
    return (
      assigned.find((v) => !this.limitOf(v) && !spec.avoid?.includes(v) && this.usable(v)) ?? vendor
    );
  }

  // -------------------------------------------------------------------------
  // Leases and agent calls

  private callFile(key: string): string {
    return this.store.roundFile(this.round, `calls/${key.replace(/[^\w.-]+/g, "_")}`);
  }

  private async reassign(
    role: AgentRole,
    from: Vendor,
    to: Vendor,
    reason: "ceiling" | "limit",
    announce = true,
  ): Promise<void> {
    const contractRole = ROLE_FOR_AGENT[role];
    const roles = this.state.roles;
    let before: Vendor[];
    let after: Vendor[];
    if (contractRole === "reviewer") {
      before = [...roles.reviewer];
      after = [...new Set(roles.reviewer.map((v) => (v === from ? to : v)))];
      if (!after.includes(to)) after.push(to);
      roles.reviewer = after;
    } else {
      before = [roles[contractRole]];
      after = [to];
      roles[contractRole] = to;
    }
    // A later call of the same round can be redirected after the role
    // already moved; that changes nothing and gets no event.
    if (before.length === after.length && before.every((v, i) => v === after[i])) return;
    await this.persist();
    // The server announces the moves it makes in a lease response; the
    // engine announces only its own.
    if (!announce) return;
    await this.emit({
      type: "role.reassigned",
      runId: this.state.id,
      role: contractRole,
      from: before.length > 0 ? before : [from],
      to: after,
      reason,
      effectiveRound: this.round,
    });
  }

  /**
   * Requests a lease, waiting through `pause` answers. Returns the vendor to
   * call and the lease id to settle, which is the server's.
   */
  async acquireLease(
    vendor: Vendor,
    role: AgentRole,
    estimateTokens: number,
    avoid: readonly Vendor[] = [],
    current?: (vendor: Vendor) => Vendor,
  ): Promise<{ vendor: Vendor; leaseId: string }> {
    let waiting = false;
    for (;;) {
      await this.checkpoint();
      // A redirect to one of these would only stop the call, so the server
      // leaves them out and pauses when nothing is left.
      const exclude = FALLBACK_ORDER.filter(
        (v) => v !== vendor && (avoid.includes(v) || !this.usable(v) || this.limitOf(v) !== null),
      );
      this.eng.counters.lease += 1;
      const requested = `${this.state.id}-L${this.eng.counters.lease}`;
      // Saved before the request: the server answers a repeated lease id
      // with its first response, so an engine that stops while this request
      // is out must not send the same id for its next call.
      await this.persist();
      let response;
      try {
        response = await this.deps.broker.acquire(
          {
            leaseId: requested,
            runId: this.state.id,
            vendor,
            role,
            estimate: { tokens: Math.max(0, Math.round(estimateTokens)) },
            ...(exclude.length > 0 ? { exclude } : {}),
          },
          this.signal,
        );
      } catch (error) {
        if (this.cancelRequested) throw new RunCancelled();
        throw error;
      }
      if (this.stopped) {
        if (response.decision === "granted") {
          await this.settle(response.leaseId, response.vendor, role, ZERO_USE);
        }
        throw new RunCancelled();
      }
      if (response.decision === "granted") {
        if (waiting) await this.endPause();
        const leaseId = response.leaseId;
        if (response.vendor !== vendor) {
          if (!this.usable(response.vendor)) {
            // The server doesn't know which CLIs this engine has; taking the
            // grant would call a vendor that can't answer, and calling the
            // requested vendor instead would ignore its ceiling.
            await this.settle(leaseId, response.vendor, role, ZERO_USE);
            const why = `this engine has no working ${response.vendor} CLI`;
            throw new DecisionNeeded({
              kind: "ceiling",
              findingIds: [],
              options: ["resume", "cancel"],
              message: `The server moved the ${role} call from ${vendor}, which is over its ceiling, to ${response.vendor}, but ${why}. No usable vendor can take the call. Resume when ${vendor} has room again, raise its ceiling, or fix ${response.vendor}'s setup.`,
            });
          }
          const limited = this.limitOf(response.vendor);
          if (limited) {
            // Only a server that ignores `exclude` does this.
            await this.settle(leaseId, response.vendor, role, ZERO_USE);
            throw new DecisionNeeded({
              kind: "ceiling",
              findingIds: [],
              options: ["resume", "cancel"],
              message: `The server moved the ${role} call from ${vendor} to ${response.vendor}, but ${response.vendor} reported a limit: ${limited.message}. Resume when ${vendor} has room again, or assign the role to another vendor.`,
            });
          }
          if (avoid.includes(response.vendor)) {
            // Taking the grant would break the cross-vendor rule; hand the
            // lease back unused and ask a person.
            await this.settle(leaseId, response.vendor, role, ZERO_USE);
            throw new DecisionNeeded({
              kind: "ceiling",
              findingIds: [],
              options: ["resume", "cancel"],
              message: `The server moved the ${role} call from ${vendor} to ${response.vendor}, but ${response.vendor} may not take it: a finding is never checked by the vendor that reported or fixed it. Resume when ${vendor} has room again, or assign the role to another vendor.`,
            });
          }
          await this.reassign(role, vendor, response.vendor, "ceiling", false);
          return { vendor: response.vendor, leaseId };
        }
        return { vendor, leaseId };
      }
      if (response.decision === "pause") {
        // Ask again before the old reset time: a person can clear a stale
        // sample, or a raised ceiling can make room, and only a new lease
        // sees that.
        const until = Date.parse(response.resumeAt) - this.clock.now();
        if (!waiting || this.state.pausedUntil !== response.resumeAt) {
          await this.setStatus("paused", { pausedUntil: response.resumeAt });
        }
        await this.waitOut(Math.min(until, LEASE_RECHECK_MS));
        if (this.cancelRequested) throw new RunCancelled();
        waiting = true;
        vendor = current?.(vendor) ?? vendor;
        continue;
      }
      if (response.action === "fail_role") throw new RoleDenied(role, vendor, response.reason);
      throw new DecisionNeeded({
        kind: "ceiling",
        findingIds: [],
        options: ["resume", "cancel"],
        message: `The server paused the run: ${response.reason}`,
      });
    }
  }

  private fallbackVendor(role: AgentRole, avoid: readonly Vendor[] = []): Vendor | null {
    if (role === "fixer") return null;
    return (
      FALLBACK_ORDER.find(
        (v) =>
          VENDOR_ROLES[v].includes(role) &&
          !this.limitOf(v) &&
          !avoid.includes(v) &&
          this.usable(v),
      ) ?? null
    );
  }

  /**
   * Makes one agent call under a lease, with events, usage, one retry, and
   * limit handling. A call already finished under the same key in this
   * round returns its saved result instead.
   */
  callAgent<T>(spec: AgentCallSpec): Promise<AgentOutcome<T>> {
    const call = this.runCall<T>(spec);
    this.calls.add(call);
    const done = () => this.calls.delete(call);
    call.then(done, done);
    return call;
  }

  private async runCall<T>(spec: AgentCallSpec): Promise<AgentOutcome<T>> {
    const cached = await this.store.readJson<AgentOutcome<T>>(this.callFile(spec.key));
    if (cached) {
      if (!cached.model || !isBlockedReviewModel(cached.vendor, cached.model)) return cached;
      // A call saved before the rule. A read-only call can run again, but a
      // write call's commits are already part of the run's history.
      if (spec.request.toolPolicy === "write") {
        throw new AgentFailed(
          spec.role,
          cached.vendor,
          blockedModelMessage(cached.vendor, cached.model),
        );
      }
    }

    let vendor = spec.vendor;
    let failures = 0;
    let malformed = false;
    for (;;) {
      vendor = await this.routeAroundLimits(spec, vendor);
      const lease = await this.acquireLease(
        vendor,
        spec.role,
        spec.estimateTokens,
        spec.avoid,
        (v) => this.assignedVendor(spec, v),
      );
      vendor = lease.vendor;
      const adapter: VendorAdapter | undefined = this.deps.adapters[vendor];
      if (!adapter)
        throw new AgentFailed(spec.role, vendor, `No adapter is configured for ${vendor}.`);
      this.eng.counters.agent += 1;
      const agentId = `${this.state.id}-A${this.eng.counters.agent}`;
      let tier = spec.tier?.tier;
      let tierReason = spec.tier?.reason;
      if (tier && malformed && !spec.tier?.fixed && tier !== "large") {
        tier = tier === "small" ? "medium" : "large";
        tierReason = `${tierReason}; the last answer was malformed, so one tier up`;
      }
      const choice = this.chooseModel(vendor, tier, spec.role);
      if (choice.note) tierReason = `${tierReason}; ${choice.note}`;
      if (choice.model !== undefined && isBlockedRequestedModel(vendor, choice.model)) {
        await this.settle(lease.leaseId, vendor, spec.role, ZERO_USE);
        throw new AgentFailed(spec.role, vendor, blockedModelMessage(vendor, choice.model));
      }
      const requestModel = choice.model;
      const effort = EFFORT_VENDORS.includes(vendor) ? spec.request.effort : undefined;
      if (effort && tierReason) tierReason = `${tierReason}; ${effort} effort`;
      const model = requestModel ?? vendor;
      const common = {
        runId: this.state.id,
        agentId,
        leaseId: lease.leaseId,
        vendor,
        model,
        role: spec.role,
        groupId: spec.groupId,
        round: this.round,
        ...(tier ? { tier } : {}),
        ...(tierReason ? { tierReason } : {}),
      };
      if (tier || effort) {
        this.deps.log?.info?.("Chose a call's model", {
          runId: this.state.id,
          agentId,
          key: spec.key,
          vendor,
          role: spec.role,
          tier,
          model,
          ...(effort ? { effort } : {}),
          reason: tierReason,
        });
      }
      await this.persist();
      await this.emit({ type: "agent.started", ...common });
      const started = this.clock.now();
      const timeoutMs = spec.request.timeoutMs ?? this.timeouts[spec.role];
      // A write call that turns out to have used a blocked model loses its commits.
      const headBefore = spec.request.toolPolicy === "write" ? await this.git.head() : null;
      let result: AdapterResult<T>;
      try {
        result =
          spec.request.toolPolicy === "read-only"
            ? await this.treeGuardFor(spec.request.repoPath).run(
                () => this.invoke<T>(adapter, spec, timeoutMs, requestModel, effort),
                (message) =>
                  this.deps.log?.warn("A failed read-only call changed the worktree", {
                    runId: this.state.id,
                    agentId,
                    vendor,
                    error: message,
                  }),
              )
            : await this.invoke<T>(adapter, spec, timeoutMs, requestModel, effort);
      } catch (error) {
        const elapsedMs = Math.max(0, this.clock.now() - started);
        const limit = this.signal.aborted ? null : adapter.detectLimit(error);
        // A failed or limited call can still hold the vendor's freshest reading.
        for (const { ceiling: _ignored, ...sample } of usageOfError(error)) {
          const ceiling = (this.deps.ceilings ?? DEFAULT_CEILINGS)[sample.vendor];
          await this.emit({ type: "usage.sample", ...sample, ceiling });
        }
        const outcome = this.signal.aborted
          ? "cancelled"
          : limit
            ? "limited"
            : error instanceof CallTimeout
              ? "timeout"
              : "error";
        await this.emit({
          type: "agent.finished",
          ...common,
          outcome,
          elapsedMs,
          tokens: { in: 0, out: 0 },
          premiumRequests: 0,
          costEstimate: 0,
        });
        await this.settle(lease.leaseId, vendor, spec.role, {
          tokens: { in: 0, out: 0 },
          premiumRequests: 0,
          costEstimate: 0,
        });
        if (outcome === "cancelled") throw new RunCancelled();
        this.deps.log?.warn("An agent call failed", {
          runId: this.state.id,
          agentId,
          key: spec.key,
          vendor,
          role: spec.role,
          outcome,
          elapsedMs,
          error: describeError(error),
        });
        if (limit) {
          // The next pass of this loop moves the call, pauses, or asks a person.
          this.noteLimit(vendor, limit);
          await this.persist();
          continue;
        }
        const text = (error as Error).message ?? String(error);
        if (SAFETY_REFUSAL.test(text)) {
          throw new SafetyRefused(
            spec.role,
            vendor,
            `The ${spec.role} call on ${vendor} was refused by the vendor's safety filter: ${text}`,
          );
        }
        failures += 1;
        malformed = isMalformedOutput(error);
        // One retry per call, unless the adapter knows a retry fails the same way.
        if (failures >= 2 || adapter.isRetryable?.(error) === false) {
          const reason = (error as Error).message ?? String(error);
          throw new AgentFailed(
            spec.role,
            vendor,
            failures >= 2
              ? `The ${spec.role} call on ${vendor} failed twice: ${reason}`
              : `The ${spec.role} call on ${vendor} failed: ${reason}`,
          );
        }
        continue;
      }
      const elapsedMs = Math.max(0, this.clock.now() - started);
      const actual: LeaseActual = {
        tokens: { in: result.tokens.in, out: result.tokens.out },
        premiumRequests: result.premiumRequests,
        ...(result.aiCredits !== undefined ? { aiCredits: result.aiCredits } : {}),
        costEstimate: result.costEstimate,
      };
      // A CLI default or an alias can resolve to a blocked model; the run stops
      // here, before anything uses the answer.
      const blocked = Boolean(result.model && isBlockedReviewModel(vendor, result.model));
      await this.emit({
        type: "agent.finished",
        ...common,
        model: result.model || model,
        outcome: blocked ? "error" : "ok",
        elapsedMs,
        tokens: actual.tokens,
        premiumRequests: actual.premiumRequests,
        ...(actual.aiCredits !== undefined ? { aiCredits: actual.aiCredits } : {}),
        costEstimate: actual.costEstimate,
      });
      await this.settle(lease.leaseId, vendor, spec.role, actual);
      for (const sample of result.usage) {
        const ceiling = (this.deps.ceilings ?? DEFAULT_CEILINGS)[sample.vendor];
        await this.emit({ type: "usage.sample", ...sample, ceiling });
      }
      if (blocked) {
        const message = blockedModelMessage(vendor, result.model);
        const undone = headBefore ? await this.undoCommits(headBefore) : "";
        throw new AgentFailed(spec.role, vendor, `${message}${undone}`);
      }
      const outcome: AgentOutcome<T> = {
        vendor,
        model: result.model || model,
        sessionId: result.sessionId,
        output: result.output,
        tokens: actual.tokens,
        ...(result.toolErrors?.length ? { toolErrors: result.toolErrors } : {}),
        ...(tier ? { tier: { tier, reason: tierReason ?? "" } } : {}),
      };
      await this.store.writeJson(this.callFile(spec.key), outcome);
      return outcome;
    }
  }

  /**
   * Moves the branch back to `head` and says so in a sentence for the error,
   * so no commit from a blocked model stays on the branch. The commits stay
   * reachable through the reflog.
   */
  private async undoCommits(head: string): Promise<string> {
    try {
      const now = await this.git.head();
      if (now === head) return "";
      await this.git.resetKeep(head);
      return ` The engine moved the branch back to ${head}; the call's commits end at ${now}.`;
    } catch (error) {
      return ` The engine couldn't remove the call's commits: ${describeError(error)}`;
    }
  }

  private async invoke<T>(
    adapter: VendorAdapter,
    spec: AgentCallSpec,
    timeoutMs: number,
    model: string | undefined,
    effort: Effort | undefined,
  ): Promise<AdapterResult<T>> {
    const controller = new AbortController();
    let rejectAborted: (error: Error) => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = reject;
    });
    aborted.catch(() => undefined);
    // One listener per call, removed in `finally`, so a long run doesn't
    // pile listeners onto the run's signal.
    const onAbort = () => {
      controller.abort(this.signal.reason);
      rejectAborted(new RunCancelled());
    };
    if (this.signal.aborted) onAbort();
    else this.signal.addEventListener("abort", onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const guard = new Promise<never>((_, reject) => {
      // The adapter enforces the timeout; this guard catches an adapter that doesn't.
      timer = setTimeout(() => {
        const err = new CallTimeout(timeoutMs);
        controller.abort(err);
        reject(err);
      }, timeoutMs + 30_000);
      timer.unref?.();
    });
    const { sessionId, timeoutMs: _t, effort: _e, ...rest } = spec.request;
    const request = {
      ...rest,
      ...(effort ? { effort } : {}),
      timeoutMs,
      model,
      signal: controller.signal,
    };
    try {
      const call =
        spec.method === "continueReview"
          ? adapter.continueReview({ ...request, sessionId: sessionId ?? "" })
          : adapter[spec.method](request);
      return (await Promise.race([call, guard, aborted])) as AdapterResult<T>;
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", onAbort);
    }
  }

  private async settle(
    leaseId: string,
    vendor: Vendor,
    role: AgentRole,
    actual: LeaseActual,
  ): Promise<void> {
    this.deps.broker.settle(leaseId, actual);
    const totals = this.eng.roundUsage[vendor] ?? {
      tokensIn: 0,
      tokensOut: 0,
      premiumRequests: 0,
      costUsd: 0,
    };
    totals.tokensIn += actual.tokens.in;
    totals.tokensOut += actual.tokens.out;
    totals.premiumRequests += actual.premiumRequests;
    if (actual.aiCredits !== undefined)
      totals.aiCredits = (totals.aiCredits ?? 0) + actual.aiCredits;
    totals.costUsd += actual.costEstimate;
    this.eng.roundUsage[vendor] = totals;
    await this.emit({
      type: "lease.settled",
      leaseId,
      runId: this.state.id,
      vendor,
      role,
      tokens: actual.tokens,
      premiumRequests: actual.premiumRequests,
      costEstimate: actual.costEstimate,
    });
  }
}

/** The usage samples an adapter attached to a failed call. */
function usageOfError(error: unknown): UsageSample[] {
  const usage = (error as { usage?: unknown } | null)?.usage;
  return Array.isArray(usage) ? (usage as UsageSample[]) : [];
}

/** An error's message for a log line, on one line and at most 500 characters. */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 500 ? `${line.slice(0, 497)}...` : line;
}
