// The live context of one review run: its state files, events, findings,
// roles, and tasks. Agent calls, leases, limits, and the pause, resume, and
// cancel controls come from the shared agent-call core in `calls/`, which
// this context hosts. The pre-push and post-push drivers build on it.
import {
  type Actor,
  type AgentRole,
  type Finding,
  type ModelTier,
  type PolicyFile,
  type Role,
  type RoundSummary,
  type RunState,
  type RunStatus,
  type Stage,
  type Verdict,
  type Vendor,
  VENDOR_ROLES,
  markTask,
  planTasks,
  skipQueued,
  taskLabel,
  type RunTaskState,
  type TaskInput,
} from "@aio/contracts";
import {
  DEFAULT_TIMEOUTS,
  systemClock,
  type Clock,
  type CommandRunner,
  type EngineDeps,
  type EventDraft,
  type RoleTimeouts,
} from "../core.js";
import {
  AgentCalls,
  chooseTierModel,
  type AgentCallHost,
  type AgentCallSpec,
  type AgentOutcome,
  type CallCache,
  type CallRouting,
  type MoveReason,
  type VendorLimit,
} from "../calls/index.js";
import { NO_EXTRAS, type PolicyExtras } from "../policy/load.js";
import { resolveReviewRange, reviewRangeSeed, type ReviewRange } from "../range/review-range.js";
import { Git } from "../range/git.js";
import { ShellRunner } from "../range/exec.js";
import type { EngineState } from "../run/engine-state.js";
import type { RunStore } from "../run/store.js";
import { EngineCheckout, readOnlyCheckoutPath } from "./checkout.js";
import { baseWorktreePath, FALLBACK_ORDER } from "../verify/verify.js";
import { assignRoles } from "./profiles.js";
import type { RangeInfo } from "../prompts/templates.js";

// The core's errors and call types, under the names the review code uses.
export {
  AgentFailed,
  DecisionNeeded,
  RoleDenied,
  RunCancelled,
  SafetyRefused,
  describeError,
  type AgentCallSpec,
  type AgentOutcome,
  type CallTier,
} from "../calls/index.js";

/** Chooses a call's model and explains a missing tier mapping. */
export function chooseCallModel(
  models: EngineDeps["models"],
  tierModels: PolicyFile["tierModels"],
  vendor: Vendor,
  tier: ModelTier | undefined,
  role: AgentRole,
): { model: string | undefined; note: string | null } {
  // A large confirmer reads the round's whole fix diff.
  return chooseTierModel(
    models,
    tierModels,
    vendor,
    tier,
    role === "confirmer" && tier === "large",
  );
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
  /** The shared agent-call core, with this run as its host. */
  readonly agents: AgentCalls;
  /** Engine-only policy settings, such as the comment authors to trust. */
  extras: PolicyExtras = NO_EXTRAS;
  /**
   * The engine-owned checkout that read-only calls run in (see
   * `checkout.ts`). Steps move it with `readOnlyRepo()` in `steps.ts`.
   */
  readonly readOnlyCheckout: EngineCheckout;
  readonly verificationCheckout: EngineCheckout;
  /** Serializes writes, since parallel agent calls update the same files. */
  private writeChain: Promise<void> = Promise.resolve();
  /** Serializes parallel callers while the saved range is being resolved. */
  private resolvingRange: { key: string; promise: Promise<ReviewRange> } | null = null;

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
    this.verificationCheckout = new EngineCheckout(this.git, baseWorktreePath(state.id));
    this.readOnlyCheckout = new EngineCheckout(this.git, readOnlyCheckoutPath(state.id));
    this.agents = new AgentCalls(this.agentHost(), deps);
  }

  /** The review run as the agent-call core sees it. */
  private agentHost(): AgentCallHost {
    const cache: CallCache = {
      read: async <T>(key: string) =>
        (await this.store.readJson<AgentOutcome<T>>(this.callFile(key))) ?? null,
      write: (key, outcome) => this.store.writeJson(this.callFile(key), outcome),
    };
    const routing: CallRouting = {
      fallbackOrder: FALLBACK_ORDER,
      canTake: (vendor, role) => VENDOR_ROLES[vendor].includes(role),
      // The fixer never moves, and a continuation stays with its session.
      movable: (spec) =>
        spec.allowFallback !== false && spec.role !== "fixer" && spec.method !== "continueReview",
      assigned: (spec, vendor, limitOf) => this.assignedVendor(spec, vendor, limitOf),
      moved: (role, from, to, reason, announce) => this.reassign(role, from, to, reason, announce),
      model: (vendor, tier, role) =>
        chooseCallModel(this.deps.models, this.policy.tierModels, vendor, tier, role),
      timeoutMs: (role) => this.timeouts[role],
    };
    return {
      id: this.state.id,
      round: () => this.round,
      ledger: () => this.eng,
      persist: () => this.persist(),
      emit: (draft) => this.emit(draft),
      status: {
        paused: () => this.state.status === "paused",
        pausedUntil: () => this.state.pausedUntil,
        pause: (until) => this.setStatus("paused", { pausedUntil: until }),
        resume: () => this.setStatus("running", { pausedUntil: undefined }),
      },
      cache,
      routing,
      treeGuard: {
        ignore: [this.store.dir],
        restore: (repoPath) => {
          const checkout = this.readOnlyCheckout;
          return repoPath === checkout.dir ? () => checkout.reset() : undefined;
        },
      },
      commits: { head: () => this.git.head(), resetKeep: (sha) => this.git.resetKeep(sha) },
      observer: {
        task: (spec, state, extra) => this.updateTask(spec, state, extra),
        starting: (spec, vendor) => {
          // A fixer can commit and then fail or stop; the confirmer must be another vendor.
          if (spec.role === "fixer" && !this.eng.roundFixers.includes(vendor)) {
            this.eng.roundFixers.push(vendor);
          }
        },
        settled: (vendor, actual) => {
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
        },
      },
    };
  }

  private callFile(key: string): string {
    return this.store.roundFile(this.round, `calls/${key.replace(/[^\w.-]+/g, "_")}`);
  }

  get signal(): AbortSignal {
    return this.agents.signal;
  }

  get round(): number {
    return this.state.round;
  }

  /** Vendors this engine has an adapter for: a CLI that answered, or a mock. */
  get availableVendors(): Vendor[] {
    return this.agents.availableVendors;
  }

  /** True when this engine has an adapter for `vendor`. */
  usable(vendor: Vendor): boolean {
    return this.agents.usable(vendor);
  }

  /** Gets the persisted range, resolving it again when the round or tip changes. */
  ensureReviewRange(): Promise<ReviewRange> {
    const tip = this.state.tipSha ?? "HEAD";
    const includeWorktree = this.eng.includeWorktree ?? this.state.request.includeWorktree;
    const input = {
      git: this.git,
      resolved: {
        baseRef: this.state.request.base,
        baseSha: this.state.baseSha ?? "",
        diffBaseSha: this.eng.diffBaseSha ?? this.state.baseSha ?? "",
        tipSha: tip,
        tipRef: this.eng.tipRef,
        includeWorktree,
        dirty: includeWorktree,
      },
      request: this.state.request,
      round: this.round,
      reviewedFrom: this.eng.reviewFrom,
      preFixSha: this.eng.preFixSha,
      policy: this.policy,
      groupSizeLimit: this.extras.groupSizeLimit ?? undefined,
      now: () => this.clock.now(),
      saved: this.eng.reviewRange,
    };
    const key = reviewRangeSeed(input).key;
    if (
      this.eng.reviewRange?.key === key &&
      this.eng.reviewRange.grouped &&
      (this.eng.reviewRange.fixRange?.baseSha ?? null) === this.eng.preFixSha
    )
      return Promise.resolve(this.eng.reviewRange);
    if (this.resolvingRange?.key === key) return this.resolvingRange.promise;
    const promise = (async () => {
      const range = await resolveReviewRange(input);
      this.eng.reviewRange = range;
      await this.persist();
      return range;
    })();
    this.resolvingRange = { key, promise };
    void promise
      .finally(() => {
        if (this.resolvingRange?.promise === promise) this.resolvingRange = null;
      })
      .catch(() => undefined);
    return promise;
  }

  async range(repoPath: string = this.state.request.repoPath): Promise<RangeInfo> {
    return { ...(await this.ensureReviewRange()).promptRange, repoPath };
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
    if (this.state.tasks) this.state.tasks = skipQueued(this.state.tasks, this.round, previous);
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
    // A whole-project run has no base, so whether a flaw is new is unknown.
    if (this.state.request.scope === "whole") finding.introduced = null;
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
  // Controls, from the agent-call core

  requestPause(): void {
    this.agents.requestPause();
  }

  requestResume(): void {
    this.agents.requestResume();
  }

  requestCancel(): void {
    this.agents.requestCancel();
  }

  get cancelled(): boolean {
    return this.agents.cancelled;
  }

  /** Called between agent calls: honors a pause or a cancel. */
  checkpoint(): Promise<void> {
    return this.agents.checkpoint();
  }

  /** Pauses the run until `until` (ISO time), as a ceiling or a limit asks. */
  pauseUntil(until: string): Promise<void> {
    return this.agents.pauseUntil(until);
  }

  /** Ends every wait for a usage limit now, such as after a person resumes the run. */
  wakePause(): void {
    this.agents.wakePause();
  }

  /** See `AgentCalls.stopCalls`. */
  stopCalls(): void {
    this.agents.stopCalls();
  }

  /** Stops what is left of the last driver's calls, then lets calls start again. */
  beginDrive(): Promise<void> {
    return this.agents.beginDrive();
  }

  /** Forgets the limits vendors reported. A person acted, so the next call finds out afresh. */
  clearVendorLimits(): void {
    this.agents.clearLimits();
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
  private assignedVendor(
    spec: AgentCallSpec,
    vendor: Vendor,
    limitOf: (v: Vendor) => VendorLimit | null,
  ): Vendor {
    if (spec.pinVendor || spec.method === "continueReview" || spec.role === "sweeper")
      return vendor;
    const role = ROLE_FOR_AGENT[spec.role];
    const manual = this.eng.manualRoles[role];
    if (manual === undefined) return vendor;
    const assigned = Array.isArray(manual) ? manual : [manual];
    if (assigned.includes(vendor)) return vendor;
    return (
      assigned.find((v) => !limitOf(v) && !spec.avoid?.includes(v) && this.usable(v)) ?? vendor
    );
  }

  /** Moves a role to another vendor in the run's roles, and announces it unless the server did. */
  private async reassign(
    role: AgentRole,
    from: Vendor,
    to: Vendor,
    reason: MoveReason,
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

  // -------------------------------------------------------------------------
  // Leases and agent calls, from the agent-call core

  /**
   * Requests a lease, waiting through `pause` answers. Returns the vendor to
   * call and the lease id to settle, which is the server's.
   */
  acquireLease(
    vendor: Vendor,
    role: AgentRole,
    estimateTokens: number,
    avoid: readonly Vendor[] = [],
    current?: (vendor: Vendor) => Vendor,
  ): Promise<{ vendor: Vendor; leaseId: string }> {
    return this.agents.acquireLease(vendor, role, estimateTokens, avoid, current);
  }

  /**
   * Makes one agent call under a lease, with events, usage, one retry, and
   * limit handling. A call already finished under the same key in this
   * round returns its saved result instead.
   */
  callAgent<T>(spec: AgentCallSpec): Promise<AgentOutcome<T>> {
    return this.agents.call<T>(spec);
  }

  /** Adds planned calls to the run's task list as queued tasks, and announces the list. */
  async planTasks(
    planned: readonly Omit<TaskInput, "round" | "stage">[],
    stage?: Stage,
  ): Promise<void> {
    if (planned.length === 0) return;
    const at = { round: this.round, stage: stage ?? this.state.stage };
    this.state.tasks = planTasks(
      this.state.tasks ?? [],
      planned.map((p) => ({ ...at, ...p })),
    );
    await this.persist();
    await this.emitRun();
  }

  /** Sets the state of a call's task, adding the task when nothing planned it. */
  private async updateTask(
    spec: AgentCallSpec,
    state: RunTaskState,
    extra: { vendor?: Vendor; effort?: string | undefined } = {},
  ): Promise<void> {
    this.state.tasks = markTask(
      this.state.tasks ?? [],
      {
        key: spec.key,
        round: this.round,
        stage: this.state.stage,
        role: spec.role,
        groupId: spec.groupId,
        label: taskLabel(spec.role, spec.key, spec.groupId),
        ...extra,
      },
      state,
      this.nowIso(),
    );
    await this.persist();
    await this.emitRun();
  }
}
