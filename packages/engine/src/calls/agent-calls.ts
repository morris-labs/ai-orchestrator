// The shared agent-call core (ADR 0007). It makes one agent call under a
// lease, with tier and model choice, the limit fallback, the call cache,
// events, the working tree guard, and the pause, resume, and cancel
// controls. Every state machine in the engine that calls agents builds on
// it; the review run context is the first. The caller's own state reaches
// the core only through `AgentCallHost`.
import {
  DEFAULT_CEILINGS,
  blockedModelMessage,
  isBlockedRequestedModel,
  isBlockedReviewModel,
  resolveReviewEffort,
  type AgentRole,
  type Effort,
  type UsageSample,
  type Vendor,
} from "@aio/contracts";
import {
  systemClock,
  type AdapterResult,
  type Clock,
  type LeaseActual,
  type LimitInfo,
  type VendorAdapter,
} from "../core.js";
import { TreeGuard } from "../state/tree-guard.js";
import {
  AgentFailed,
  CallHeld,
  CallTimeout,
  RoleDenied,
  RunCancelled,
  SafetyRefused,
  ceilingDecision,
  describeError,
} from "./errors.js";
import type {
  AgentCallHost,
  AgentCallSpec,
  AgentOutcome,
  CallDeps,
  CallState,
  CallWork,
  VendorLimit,
} from "./types.js";

/** A vendor's safety filter refused the request. Repeating the call gets the same answer. */
const SAFETY_REFUSAL = /flagged for possible cybersecurity risk|cyber permissive safeguards/i;

/** How often a caller waiting out a ceiling asks the server again. */
const LEASE_RECHECK_MS = 60_000;

/** How long a rate limit with no usable reset time keeps a vendor out. */
const RATE_LIMIT_BLOCK_MS = 15 * 60_000;

/** The shortest block after a limit, so a reset time in the past can't make a tight loop. */
const MIN_LIMIT_BLOCK_MS = 60_000;

/** The longest single sleep: a longer timer fires at once. */
const MAX_SLEEP_MS = 2_000_000_000;

/** The vendors the engine knows, in a fixed order. */
const VENDORS = ["claude", "codex", "copilot"] as const;

const ZERO_USE: LeaseActual = { tokens: { in: 0, out: 0 }, premiumRequests: 0, costEstimate: 0 };

/** True for a vendor's answer that didn't match the output schema. */
function isMalformedOutput(error: unknown): boolean {
  return (error as { kind?: unknown } | null)?.kind === "output";
}

/** The usage samples an adapter attached to a failed call. */
function usageOfError(error: unknown): UsageSample[] {
  const usage = (error as { usage?: unknown } | null)?.usage;
  return Array.isArray(usage) ? (usage as UsageSample[]) : [];
}

/**
 * The tokens a failed call spent before it failed, from the adapter's
 * error, or none when the adapter couldn't tell.
 */
function tokensOfError(error: unknown): LeaseActual["tokens"] {
  const tokens = (error as { tokens?: Record<string, unknown> } | null)?.tokens;
  if (!tokens || typeof tokens.input !== "number" || typeof tokens.output !== "number")
    return { in: 0, out: 0 };
  const extra = (key: "fresh" | "cacheWrite" | "cacheRead") =>
    typeof tokens[key] === "number" ? { [key]: tokens[key] } : {};
  return {
    in: tokens.input,
    out: tokens.output,
    ...extra("fresh"),
    ...extra("cacheWrite"),
    ...extra("cacheRead"),
  };
}

/**
 * Makes agent calls for one caller, such as a review run or a build. One
 * instance per caller: it holds the caller's abort signal, pause gate, and
 * calls in progress.
 */
export class AgentCalls {
  readonly clock: Clock;
  private abort = new AbortController();
  /** Ends the waits of pauses for a usage limit early; parallel calls wait separately. */
  private readonly pauseWakes = new Set<AbortController>();
  /** Agent calls in progress, including ones that outlive a stopped driver. */
  private readonly inFlight = new Set<Promise<unknown>>();
  /** True from when the driver stops until the next one starts: leftover calls start nothing. */
  private stopped = false;
  private pauseRequested = false;
  private cancelRequested = false;
  /** Every parallel call waits on the same gate while the caller is paused. */
  private pauseGate: { promise: Promise<void>; open: () => void } | null = null;
  /** Callers that wait at a checkpoint for a person's pause to end. */
  private parked = 0;
  /** True from `beginDrive()` to `endDrive()`. */
  private driving = false;
  /** What `host.status.held()` last reported. */
  private reportedHeld = false;
  /** Checks that read-only calls leave their worktree as they found it, one guard per worktree. */
  private readonly treeGuards = new Map<string, TreeGuard>();

  constructor(
    private readonly host: AgentCallHost,
    private readonly deps: CallDeps,
  ) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Aborts when the caller is cancelled or a new driver replaces the last one. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  /** True once `requestCancel` ran. */
  get cancelled(): boolean {
    return this.cancelRequested;
  }

  /** Vendors this engine has an adapter for: a CLI that answered, or a mock. */
  get availableVendors(): Vendor[] {
    return VENDORS.filter((v) => this.usable(v));
  }

  /** True when this engine has an adapter for `vendor`. */
  usable(vendor: Vendor): boolean {
    return this.deps.adapters[vendor] !== undefined;
  }

  // -------------------------------------------------------------------------
  // Controls

  /** Holds new calls at their next checkpoint until `requestResume`. */
  requestPause(): void {
    this.pauseRequested = true;
  }

  /** Lets held calls go on. */
  requestResume(): void {
    this.pauseRequested = false;
    // The host clears what it shows when it resumes.
    this.reportedHeld = false;
    const gate = this.pauseGate;
    this.pauseGate = null;
    gate?.open();
  }

  /** Aborts every call and makes every later checkpoint throw `RunCancelled`. */
  requestCancel(): void {
    this.cancelRequested = true;
    this.abort.abort(new RunCancelled());
    this.requestResume();
  }

  /** True while a person's pause is requested, until the resume. */
  get pausing(): boolean {
    return this.pauseRequested;
  }

  /**
   * Resolves when no person's pause holds the caller: at once without one,
   * otherwise at the resume, a cancel, or a stopped driver. It changes no
   * status, so work that no driver waits on can wait here.
   */
  untilResumed(): Promise<void> {
    if (!this.pauseRequested) return Promise.resolve();
    return this.gate().promise;
  }

  /** The gate that held callers wait on, made on first use. */
  private gate(): { promise: Promise<void>; open: () => void } {
    if (this.pauseGate) return this.pauseGate;
    let open = () => undefined as void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.pauseGate = { promise, open };
    return this.pauseGate;
  }

  /** Called between agent calls: honors a pause or a cancel. */
  async checkpoint(): Promise<void> {
    this.throwIfStopped();
    if (this.cancelRequested) throw new RunCancelled();
    if (!this.pauseRequested) return;
    const fresh = this.pauseGate === null;
    const gate = this.gate();
    if (fresh) {
      // A person's pause has no end time, even when it follows a timed wait.
      await this.host.status.pause(undefined);
    }
    this.parked += 1;
    try {
      await this.reportHeld();
      await gate.promise;
    } finally {
      this.parked -= 1;
    }
    this.throwIfStopped();
    if (this.cancelRequested) throw new RunCancelled();
    if (this.host.status.paused()) await this.host.status.resume();
  }

  /** A call's checkpoint: a background call throws `CallHeld` where another call would wait. */
  private async callCheckpoint(work: CallWork): Promise<void> {
    if (work.background && this.pauseRequested && !this.stopped && !this.cancelRequested) {
      throw new CallHeld();
    }
    await this.checkpoint();
  }

  /**
   * Whether a person's pause holds the caller: its driver waits at a
   * checkpoint for it or has ended, and no agent call runs.
   */
  get held(): boolean {
    return this.pauseRequested && (this.parked > 0 || !this.driving) && this.inFlight.size === 0;
  }

  /** Tells the host when `held` changed since the last report. */
  async reportHeld(): Promise<void> {
    const held = this.held;
    if (held === this.reportedHeld) return;
    this.reportedHeld = held;
    try {
      await this.host.status.held?.(held);
    } catch (error) {
      this.deps.log?.warn("Could not show whether a pause holds", { error: String(error) });
    }
  }

  /** Pauses the caller until `until` (ISO time), as a ceiling or a limit asks. */
  async pauseUntil(until: string): Promise<void> {
    this.throwIfStopped();
    await this.waitOut(Date.parse(until) - this.clock.now(), () => this.host.status.pause(until));
    await this.endPause();
  }

  /**
   * Returns the caller to running after a timed wait. It stays paused while
   * another call still waits, so a person can still resume it, or while a
   * person's pause holds it, so a closed gate never sits under running.
   */
  private async endPause(): Promise<void> {
    this.throwIfStopped();
    if (this.cancelRequested) throw new RunCancelled();
    if (this.pauseWakes.size > 0 || this.pauseRequested) return;
    await this.host.status.resume();
  }

  /**
   * Runs `announce`, then waits for `ms`, or until a person wakes the pause.
   * The wait registers before `announce` starts, so a cancel or a wake that
   * lands during `announce` ends the wait at once.
   */
  private async waitOut(ms: number, announce?: () => Promise<void>): Promise<void> {
    if (this.signal.aborted) throw new RunCancelled();
    const wake = new AbortController();
    this.pauseWakes.add(wake);
    const onCancel = () => wake.abort();
    this.signal.addEventListener("abort", onCancel, { once: true });
    try {
      await announce?.();
      if (ms <= 0) return;
      try {
        await this.clock.sleep(Math.min(ms, MAX_SLEEP_MS), wake.signal);
      } catch {
        if (this.signal.aborted) throw new RunCancelled();
      }
    } finally {
      this.signal.removeEventListener("abort", onCancel);
      this.pauseWakes.delete(wake);
    }
  }

  /** Ends every wait for a usage limit now, such as after a person resumes the caller. */
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
    if (this.inFlight.size > 0) {
      this.stopped = true;
      this.abort.abort(new RunCancelled());
      await Promise.allSettled([...this.inFlight]);
    }
    if (this.abort.signal.aborted && !this.cancelRequested) this.abort = new AbortController();
    this.stopped = false;
    this.driving = true;
  }

  /** Marks the driver as ended, so a person's pause holds once no call runs. */
  async endDrive(): Promise<void> {
    this.driving = false;
    await this.reportHeld();
  }

  private throwIfStopped(): void {
    if (this.stopped) throw new RunCancelled();
  }

  // -------------------------------------------------------------------------
  // Limits

  /** Forgets the limits vendors reported. A person acted, so the next call finds out afresh. */
  clearLimits(): void {
    this.host.ledger().limitedVendors = {};
  }

  /** The vendor's recorded limit, or `null` when it has none or it passed. */
  limitOf(vendor: Vendor): VendorLimit | null {
    const limits = this.host.ledger().limitedVendors;
    const limit = limits[vendor];
    if (!limit) return null;
    if (limit.until !== null && Date.parse(limit.until) <= this.clock.now()) {
      delete limits[vendor];
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
    this.host.ledger().limitedVendors[vendor] = {
      until: until === null ? null : new Date(until).toISOString(),
      message: limit.message,
    };
  }

  private assigned(spec: AgentCallSpec, vendor: Vendor): Vendor {
    return this.host.routing.assigned(spec, vendor, (v) => this.limitOf(v));
  }

  /**
   * The vendor a call may use given the recorded limits. It moves the call to
   * another vendor that can take the role. With none, it pauses until the
   * first known reset, or asks a person when no reset time is known, so no
   * call goes to a vendor that just reported a limit.
   */
  private async routeAroundLimits(spec: AgentCallSpec, start: Vendor): Promise<Vendor> {
    const routing = this.host.routing;
    let vendor = start;
    for (;;) {
      await this.callCheckpoint(spec);
      vendor = this.assigned(spec, vendor);
      const limit = this.limitOf(vendor);
      if (!limit) return vendor;
      const movable = routing.movable(spec);
      if (movable) {
        const next = this.fallbackVendor(spec.role, spec.avoid);
        if (next) {
          await routing.moved(spec.role, vendor, next, "limit", true);
          return next;
        }
      }
      const others = movable
        ? routing.fallbackOrder.filter(
            (v) =>
              v !== vendor &&
              routing.canTake(v, spec.role) &&
              !spec.avoid?.includes(v) &&
              this.usable(v),
          )
        : [];
      const resets = [vendor, ...others].flatMap((v) => this.limitOf(v)?.until ?? []);
      if (resets.length === 0) {
        throw ceilingDecision(
          `${vendor} reported a limit with no reset time: ${limit.message}. No other usable vendor can take the ${spec.role} call. Assign the role to another vendor, or resume when ${vendor} has room again.`,
        );
      }
      const earliest = resets.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
      await this.pauseUntil(earliest);
    }
  }

  private fallbackVendor(role: AgentRole, avoid: readonly Vendor[] = []): Vendor | null {
    const routing = this.host.routing;
    return (
      routing.fallbackOrder.find(
        (v) => routing.canTake(v, role) && !this.limitOf(v) && !avoid.includes(v) && this.usable(v),
      ) ?? null
    );
  }

  // -------------------------------------------------------------------------
  // Leases

  /**
   * Requests a lease, waiting through `pause` answers. Returns the vendor to
   * call and the lease id to settle, which is the server's. `current` gives
   * the vendor to ask for again after a wait, such as after a person
   * assigned the role elsewhere.
   */
  async acquireLease(
    vendor: Vendor,
    role: AgentRole,
    estimateTokens: number,
    avoid: readonly Vendor[] = [],
    current?: (vendor: Vendor) => Vendor,
    work: CallWork = {},
  ): Promise<{ vendor: Vendor; leaseId: string }> {
    const host = this.host;
    let waiting = false;
    for (;;) {
      await this.callCheckpoint(work);
      // A redirect to one of these would only stop the call, so the server
      // leaves them out and pauses when nothing is left.
      const exclude = host.routing.fallbackOrder.filter(
        (v) => v !== vendor && (avoid.includes(v) || !this.usable(v) || this.limitOf(v) !== null),
      );
      const ledger = host.ledger();
      ledger.counters.lease += 1;
      const requested = `${host.id}-L${ledger.counters.lease}`;
      // Saved before the request: the server answers a repeated lease id
      // with its first response, so an engine that stops while this request
      // is out must not send the same id for its next call.
      await host.persist();
      let response;
      try {
        response = await this.deps.broker.acquire(
          {
            leaseId: requested,
            ...this.ownerFields(work),
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
          await this.settle(response.leaseId, response.vendor, role, ZERO_USE, work);
        }
        throw new RunCancelled();
      }
      if (response.decision === "granted") {
        const leaseId = response.leaseId;
        if (waiting) {
          try {
            await this.endPause();
          } catch (error) {
            await this.settle(leaseId, response.vendor, role, ZERO_USE, work);
            throw error;
          }
        }
        if (response.vendor !== vendor) {
          if (!this.usable(response.vendor)) {
            // The server doesn't know which CLIs this engine has; taking the
            // grant would call a vendor that can't answer, and calling the
            // requested vendor instead would ignore its ceiling.
            await this.settle(leaseId, response.vendor, role, ZERO_USE, work);
            const why = `this engine has no working ${response.vendor} CLI`;
            throw ceilingDecision(
              `The server moved the ${role} call from ${vendor}, which is over its ceiling, to ${response.vendor}, but ${why}. No usable vendor can take the call. Resume when ${vendor} has room again, raise its ceiling, or fix ${response.vendor}'s setup.`,
            );
          }
          const limited = this.limitOf(response.vendor);
          if (limited) {
            // Only a server that ignores `exclude` does this.
            await this.settle(leaseId, response.vendor, role, ZERO_USE, work);
            throw ceilingDecision(
              `The server moved the ${role} call from ${vendor} to ${response.vendor}, but ${response.vendor} reported a limit: ${limited.message}. Resume when ${vendor} has room again, or assign the role to another vendor.`,
            );
          }
          if (avoid.includes(response.vendor)) {
            // Taking the grant would break the cross-vendor rule; hand the
            // lease back unused and ask a person.
            await this.settle(leaseId, response.vendor, role, ZERO_USE, work);
            throw ceilingDecision(
              `The server moved the ${role} call from ${vendor} to ${response.vendor}, but ${response.vendor} may not take it: a finding is never checked by the vendor that reported or fixed it. Resume when ${vendor} has room again, or assign the role to another vendor.`,
            );
          }
          try {
            await host.routing.moved(role, vendor, response.vendor, "ceiling", false);
          } catch (error) {
            await this.settle(leaseId, response.vendor, role, ZERO_USE, work);
            throw error;
          }
          return { vendor: response.vendor, leaseId };
        }
        return { vendor, leaseId };
      }
      if (response.decision === "pause") {
        // Ask again before the old reset time: a person can clear a stale
        // sample, or a raised ceiling can make room, and only a new lease
        // sees that.
        const until = Date.parse(response.resumeAt) - this.clock.now();
        const announce =
          !waiting || host.status.pausedUntil() !== response.resumeAt
            ? () => host.status.pause(response.resumeAt)
            : undefined;
        await this.waitOut(Math.min(until, LEASE_RECHECK_MS), announce);
        if (this.cancelRequested) throw new RunCancelled();
        waiting = true;
        vendor = current?.(vendor) ?? vendor;
        continue;
      }
      if (response.action === "fail_role") throw new RoleDenied(role, vendor, response.reason);
      throw ceilingDecision(`The server paused the run: ${response.reason}`);
    }
  }

  /** The owner, seat, step, and specialty fields of a lease and of a call's events. */
  private ownerFields(work: CallWork) {
    const owner = this.host.owner ?? { runId: this.host.id };
    return {
      runId: owner.runId,
      ...(owner.buildId !== undefined ? { buildId: owner.buildId } : {}),
      ...(work.seat !== undefined ? { seat: work.seat } : {}),
      ...(work.step !== undefined ? { step: work.step } : {}),
      ...(work.specialties?.length ? { specialties: [...work.specialties] } : {}),
    };
  }

  private async settle(
    leaseId: string,
    vendor: Vendor,
    role: AgentRole,
    actual: LeaseActual,
    work: CallWork,
  ): Promise<void> {
    this.deps.broker.settle(leaseId, actual);
    this.host.observer?.settled?.(vendor, actual);
    await this.host.emit({
      type: "lease.settled",
      leaseId,
      ...this.ownerFields(work),
      vendor,
      role,
      tokens: actual.tokens,
      premiumRequests: actual.premiumRequests,
      costEstimate: actual.costEstimate,
      ...(work.placement ? { placement: work.placement } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // Agent calls

  /**
   * Makes one agent call under a lease, with events, usage, one retry, and
   * limit handling. A call already finished under the same key returns its
   * cached result instead.
   */
  call<T>(spec: AgentCallSpec): Promise<AgentOutcome<T>> {
    const call = this.runCall<T>(spec).then(
      async (outcome) => {
        await this.track(spec, "done", { vendor: outcome.vendor });
        return outcome;
      },
      async (error: unknown) => {
        const skipped = error instanceof RunCancelled || error instanceof CallHeld;
        await this.track(spec, skipped ? "skipped" : "failed");
        throw error;
      },
    );
    this.inFlight.add(call);
    void this.reportHeld();
    const done = () => {
      this.inFlight.delete(call);
      void this.reportHeld();
    };
    call.then(done, done);
    return call;
  }

  private async track(
    spec: AgentCallSpec,
    state: CallState,
    extra: { vendor?: Vendor; effort?: string | undefined } = {},
  ): Promise<void> {
    await this.host.observer?.task?.(spec, state, extra);
  }

  /**
   * The guard for read-only calls in `repoPath`. Only a worktree the caller
   * can restore gets restored after a call changed it; any other worktree,
   * such as the checkout under review, is only reported.
   */
  private treeGuardFor(repoPath: string): TreeGuard {
    let guard = this.treeGuards.get(repoPath);
    if (!guard) {
      const restore = this.host.treeGuard.restore?.(repoPath);
      guard = new TreeGuard({
        runner: this.deps.runner,
        repoPath,
        ignore: this.host.treeGuard.ignore,
        ...(restore ? { restore } : {}),
      });
      this.treeGuards.set(repoPath, guard);
    }
    return guard;
  }

  private async runCall<T>(spec: AgentCallSpec): Promise<AgentOutcome<T>> {
    const host = this.host;
    const log = this.deps.log;
    const cached = await host.cache.read<T>(spec.key);
    if (cached) {
      if (!cached.model || !isBlockedReviewModel(cached.vendor, cached.model)) return cached;
      // A call saved before the rule. A read-only call can run again, but a
      // write call's commits are already part of the caller's history.
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
      host.observer?.leasing?.(spec, vendor);
      const lease = await this.acquireLease(
        vendor,
        spec.role,
        spec.estimateTokens,
        spec.avoid,
        (v) => this.assigned(spec, v),
        spec,
      );
      vendor = lease.vendor;
      // The usage to settle the lease with if the call ends before it settles
      // the lease itself, such as when an event or a save fails; `null` once
      // the lease is settled. Settling in `finally` keeps a lease from staying
      // open against the vendor's ceiling, whatever throws.
      let unsettled: LeaseActual | null = ZERO_USE;
      const leaseVendor = vendor;
      const settleLease = async (actual: LeaseActual): Promise<void> => {
        unsettled = null;
        await this.settle(lease.leaseId, leaseVendor, spec.role, actual, spec);
      };
      try {
        const adapter: VendorAdapter | undefined = this.deps.adapters[vendor];
        if (!adapter)
          throw new AgentFailed(spec.role, vendor, `No adapter is configured for ${vendor}.`);
        const ledger = host.ledger();
        ledger.counters.agent += 1;
        const agentId = `${host.id}-A${ledger.counters.agent}`;
        let tier = spec.tier?.tier;
        let tierReason = spec.tier?.reason;
        if (tier && malformed && !spec.tier?.fixed && tier !== "large") {
          tier = tier === "small" ? "medium" : "large";
          tierReason = `${tierReason}; the last answer was malformed, so one tier up`;
        }
        const choice = host.routing.model(vendor, tier, spec.role);
        if (choice.model !== undefined && isBlockedRequestedModel(vendor, choice.model)) {
          await settleLease(ZERO_USE);
          throw new AgentFailed(spec.role, vendor, blockedModelMessage(vendor, choice.model));
        }
        const requestModel = choice.model;
        const { effort, note } = resolveReviewEffort(spec.request.effort, vendor, requestModel);
        tierReason =
          [tierReason, choice.note, note ?? (effort && tierReason ? `${effort} effort` : null)]
            .filter(Boolean)
            .join("; ") || undefined;
        const model = requestModel ?? vendor;
        const common = {
          ...this.ownerFields(spec),
          agentId,
          leaseId: lease.leaseId,
          vendor,
          model,
          role: spec.role,
          groupId: spec.groupId,
          round: host.round(),
          ...(tier ? { tier } : {}),
          ...(tierReason ? { tierReason } : {}),
          ...(effort ? { effort } : {}),
          ...(spec.placement ? { placement: spec.placement } : {}),
        };
        if (tier || effort || note) {
          log?.info?.("Chose a call's model", {
            runId: host.id,
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
        // Saved before the call: a writer can commit and then fail or stop.
        host.observer?.starting?.(spec, vendor);
        await host.persist();
        await host.emit({ type: "agent.started", ...common });
        await this.track(spec, "running", { vendor, effort });
        const started = this.clock.now();
        const timeoutMs = spec.request.timeoutMs ?? host.routing.timeoutMs(spec.role);
        // A write call that turns out to have used a blocked model loses its commits.
        const headBefore =
          spec.request.toolPolicy === "write" && host.commits ? await host.commits.head() : null;
        let result: AdapterResult<T>;
        try {
          result =
            spec.request.toolPolicy === "read-only"
              ? await this.treeGuardFor(spec.request.repoPath).run(
                  () => this.invoke<T>(adapter, spec, timeoutMs, requestModel, effort),
                  (message) =>
                    log?.warn("A failed read-only call changed the worktree", {
                      runId: host.id,
                      agentId,
                      vendor,
                      error: message,
                    }),
                )
              : await this.invoke<T>(adapter, spec, timeoutMs, requestModel, effort);
        } catch (error) {
          const elapsedMs = Math.max(0, this.clock.now() - started);
          // The caller's cancel, or this call's own stop.
          const stopped = this.signal.aborted || spec.signal?.aborted === true;
          const limit = stopped ? null : adapter.detectLimit(error);
          // A failed or limited call can still hold the vendor's freshest reading.
          for (const { ceiling: _ignored, ...sample } of usageOfError(error)) {
            const ceiling = (this.deps.ceilings ?? DEFAULT_CEILINGS)[sample.vendor];
            await host.emit({ type: "usage.sample", ...sample, ceiling, agentId });
          }
          const outcome = stopped
            ? "cancelled"
            : limit
              ? "limited"
              : error instanceof CallTimeout
                ? "timeout"
                : "error";
          // A failed call still spent what it used before it failed.
          const spent: LeaseActual = { ...ZERO_USE, tokens: tokensOfError(error) };
          await host.emit({
            type: "agent.finished",
            ...common,
            outcome,
            elapsedMs,
            tokens: spent.tokens,
            premiumRequests: 0,
            costEstimate: 0,
          });
          await settleLease(spent);
          if (outcome === "cancelled") throw new RunCancelled();
          log?.warn("An agent call failed", {
            runId: host.id,
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
            await host.persist();
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
          tokens: { ...result.tokens },
          premiumRequests: result.premiumRequests,
          ...(result.aiCredits !== undefined ? { aiCredits: result.aiCredits } : {}),
          costEstimate: result.costEstimate,
        };
        unsettled = actual;
        // A CLI default or an alias can resolve to a blocked model; the call
        // stops here, before anything uses the answer.
        const blocked = Boolean(result.model && isBlockedReviewModel(vendor, result.model));
        await host.emit({
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
        await settleLease(actual);
        for (const sample of result.usage) {
          const ceiling = (this.deps.ceilings ?? DEFAULT_CEILINGS)[sample.vendor];
          await host.emit({ type: "usage.sample", ...sample, ceiling, agentId });
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
          ...(result.accountFolder !== undefined ? { accountFolder: result.accountFolder } : {}),
          output: result.output,
          tokens: actual.tokens,
          ...(result.toolErrors?.length ? { toolErrors: result.toolErrors } : {}),
          ...(tier ? { tier: { tier, reason: tierReason ?? "" } } : {}),
        };
        await host.cache.write(spec.key, outcome);
        return outcome;
      } finally {
        if (unsettled !== null) {
          try {
            await settleLease(unsettled);
          } catch (error) {
            // The error under way says more than this one.
            log?.warn("Could not settle a call's lease", {
              runId: host.id,
              leaseId: lease.leaseId,
              error: describeError(error),
            });
          }
        }
      }
    }
  }

  /**
   * Moves the branch back to `head` and says so in a sentence for the error,
   * so no commit from a blocked model stays on the branch. The commits stay
   * reachable through the reflog.
   */
  private async undoCommits(head: string): Promise<string> {
    const commits = this.host.commits;
    if (!commits) return "";
    try {
      const now = await commits.head();
      if (now === head) return "";
      await commits.resetKeep(head);
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
    // One listener per call, removed in `finally`, so a long caller doesn't
    // pile listeners onto its signal.
    const signal = this.signal;
    const own = spec.signal;
    const onAbort = () => {
      controller.abort(signal.aborted ? signal.reason : own?.reason);
      rejectAborted(new RunCancelled());
    };
    if (signal.aborted || own?.aborted) onAbort();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      own?.addEventListener("abort", onAbort, { once: true });
    }
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
      // A named session is resumed whatever the method; a continuation needs one.
      const call =
        spec.method === "continueReview"
          ? adapter.continueReview({ ...request, sessionId: sessionId ?? "" })
          : adapter[spec.method](sessionId !== undefined ? { ...request, sessionId } : request);
      return (await Promise.race([call, guard, aborted])) as AdapterResult<T>;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      own?.removeEventListener("abort", onAbort);
    }
  }
}
