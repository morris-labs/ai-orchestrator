// The live context of one run: its state files, events, leases, agent calls,
// and the pause, resume, and cancel controls. The pre-push and post-push
// drivers build on it.
import {
  DEFAULT_CEILINGS,
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
} from "@agentbox/contracts";
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
  type RoleTimeouts,
  type VendorAdapter,
} from "../core.js";
import { Git } from "../range/git.js";
import { ShellRunner } from "../range/exec.js";
import type { EngineState } from "../run/engine-state.js";
import type { RunStore } from "../run/store.js";
import { FALLBACK_ORDER } from "../verify/verify.js";
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

export interface AgentCallSpec {
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
}

export interface AgentOutcome<T> {
  vendor: Vendor;
  model: string;
  sessionId: string | null;
  output: T;
  tokens: { in: number; out: number };
}

const ROLE_FOR_AGENT: Record<AgentRole, Role> = {
  reviewer: "reviewer",
  disprover: "disprover",
  confirmer: "confirmer",
  fixer: "fixer",
  sweeper: "reviewer",
};

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
  private pauseRequested = false;
  private cancelRequested = false;
  /** Every parallel call waits on the same gate while the run is paused. */
  private pauseGate: { promise: Promise<void>; open: () => void } | null = null;
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
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get round(): number {
    return this.state.round;
  }

  get availableVendors(): Vendor[] {
    return (["claude", "codex", "copilot"] as const).filter(
      (v) => this.deps.adapters[v] !== undefined,
    );
  }

  range(): RangeInfo {
    return {
      repoPath: this.state.request.repoPath,
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

  /** Writes state.json, engine.json, and findings.json. */
  persist(): Promise<void> {
    this.state.updatedAt = this.nowIso();
    const state = structuredClone(this.state);
    const eng = structuredClone(this.eng);
    const findings = structuredClone(this.findings);
    this.writeChain = this.writeChain.then(async () => {
      await this.store.saveState(state);
      await this.store.saveEngineState(eng);
      await this.store.saveFindings(findings);
    });
    return this.writeChain;
  }

  async emit(draft: EventDraft): Promise<void> {
    const event = this.deps.events.emit(draft);
    this.writeChain = this.writeChain.then(() => this.store.appendEvent(event));
    await this.writeChain;
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
    if (this.cancelRequested) throw new RunCancelled();
    if (this.state.status === "paused") await this.setStatus("running", { pausedUntil: undefined });
  }

  /** Pauses the run until `until` (ISO time), as a ceiling or a limit asks. */
  async pauseUntil(until: string): Promise<void> {
    await this.setStatus("paused", { pausedUntil: until });
    const ms = Date.parse(until) - this.clock.now();
    try {
      if (ms > 0) await this.clock.sleep(ms, this.signal);
    } catch {
      throw new RunCancelled();
    }
    if (this.cancelRequested) throw new RunCancelled();
    this.state.pausedUntil = undefined;
    await this.setStatus("running");
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

  /** Requests a lease, waiting through `pause` answers. Returns the vendor to call. */
  async acquireLease(
    vendor: Vendor,
    role: AgentRole,
    estimateTokens: number,
  ): Promise<{ vendor: Vendor; leaseId: string }> {
    for (;;) {
      await this.checkpoint();
      this.eng.counters.lease += 1;
      const leaseId = `${this.state.id}-L${this.eng.counters.lease}`;
      const response = await this.deps.broker.acquire({
        leaseId,
        runId: this.state.id,
        vendor,
        role,
        estimate: { tokens: Math.max(0, Math.round(estimateTokens)) },
      });
      if (response.decision === "granted") {
        if (response.vendor !== vendor && this.deps.adapters[response.vendor]) {
          await this.reassign(role, vendor, response.vendor, "ceiling");
          return { vendor: response.vendor, leaseId };
        }
        return { vendor, leaseId };
      }
      if (response.decision === "pause") {
        await this.pauseUntil(response.resumeAt);
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

  private fallbackVendor(role: AgentRole, tried: readonly Vendor[]): Vendor | null {
    if (role === "fixer") return null;
    return (
      FALLBACK_ORDER.find((v) => !tried.includes(v) && this.deps.adapters[v] !== undefined) ?? null
    );
  }

  /**
   * Makes one agent call under a lease, with events, usage, one retry, and
   * limit handling. A call already finished under the same key in this
   * round returns its saved result instead.
   */
  async callAgent<T>(spec: AgentCallSpec): Promise<AgentOutcome<T>> {
    const cached = await this.store.readJson<AgentOutcome<T>>(this.callFile(spec.key));
    if (cached) return cached;

    let vendor = spec.vendor;
    const tried: Vendor[] = [];
    let failures = 0;
    let limitHits = 0;
    for (;;) {
      const lease = await this.acquireLease(vendor, spec.role, spec.estimateTokens);
      vendor = lease.vendor;
      const adapter: VendorAdapter | undefined = this.deps.adapters[vendor];
      if (!adapter)
        throw new AgentFailed(spec.role, vendor, `No adapter is configured for ${vendor}.`);
      this.eng.counters.agent += 1;
      const agentId = `${this.state.id}-A${this.eng.counters.agent}`;
      const model = this.deps.models?.[vendor] ?? vendor;
      const common = {
        runId: this.state.id,
        agentId,
        leaseId: lease.leaseId,
        vendor,
        model,
        role: spec.role,
        groupId: spec.groupId,
        round: this.round,
      };
      await this.persist();
      await this.emit({ type: "agent.started", ...common });
      const started = this.clock.now();
      const timeoutMs = spec.request.timeoutMs ?? this.timeouts[spec.role];
      let result: AdapterResult<T>;
      try {
        result = await this.invoke<T>(adapter, spec, timeoutMs);
      } catch (error) {
        const elapsedMs = Math.max(0, this.clock.now() - started);
        const limit = this.signal.aborted ? null : adapter.detectLimit(error);
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
        if (limit) {
          limitHits += 1;
          if (limitHits > 4)
            throw new AgentFailed(
              spec.role,
              vendor,
              `${vendor} kept hitting its limit: ${limit.message}`,
            );
          tried.push(vendor);
          const next = spec.allowFallback === false ? null : this.fallbackVendor(spec.role, tried);
          if (next) {
            await this.reassign(spec.role, vendor, next, "limit");
            vendor = next;
          } else {
            await this.pauseUntil(
              limit.resetAt ?? new Date(this.clock.now() + 15 * 60_000).toISOString(),
            );
          }
          continue;
        }
        failures += 1;
        // One retry per call, unless the adapter knows a retry fails the same way.
        if (failures >= 2 || adapter.isRetryable?.(error) === false) {
          throw new AgentFailed(
            spec.role,
            vendor,
            `The ${spec.role} call on ${vendor} failed twice: ${(error as Error).message ?? String(error)}`,
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
      await this.emit({
        type: "agent.finished",
        ...common,
        model: result.model || model,
        outcome: "ok",
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
      const outcome: AgentOutcome<T> = {
        vendor,
        model: result.model || model,
        sessionId: result.sessionId,
        output: result.output,
        tokens: actual.tokens,
      };
      await this.store.writeJson(this.callFile(spec.key), outcome);
      return outcome;
    }
  }

  private async invoke<T>(
    adapter: VendorAdapter,
    spec: AgentCallSpec,
    timeoutMs: number,
  ): Promise<AdapterResult<T>> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(this.signal.reason);
    this.signal.addEventListener("abort", onAbort, { once: true });
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
    const aborted = new Promise<never>((_, reject) => {
      if (this.signal.aborted) reject(new RunCancelled());
      this.signal.addEventListener("abort", () => reject(new RunCancelled()), { once: true });
    });
    aborted.catch(() => undefined);
    const { sessionId, timeoutMs: _t, ...rest } = spec.request;
    const request = {
      ...rest,
      timeoutMs,
      model: this.deps.models?.[adapter.vendor],
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
