// The public face of a run: create or load it, drive it, and apply the
// controls the engine API exposes (pause, resume, cancel, profile, assign,
// rebase-base, decision, push). W5's API handlers call these methods.
import {
  EngineRunCreateSchema,
  RUNS_DIR,
  type DecisionAnswer,
  type EngineRunCreate,
  type FileGroup,
  type Finding,
  type Profile,
  type Role,
  type RoleOverrides,
  type RoundSummary,
  type RunRetry,
  type RunState,
  type Vendor,
} from "@aio/contracts";
import type { z } from "zod";
import { EngineError } from "../api/core-interface.js";
import type { EngineDeps } from "../core.js";
import { systemClock } from "../core.js";
import { DEFAULT_POLICY } from "@aio/contracts";
import { loadPolicy, loadPolicyExtras } from "../policy/load.js";
import { Git } from "../range/git.js";
import { baseWorktreePath, removeBaseWorktree } from "../verify/verify.js";
import { drivePostPush } from "../postpush/loop.js";
import { resolveRange } from "../range/resolve.js";
import { newEngineState } from "../run/engine-state.js";
import { RunStore } from "../run/store.js";
import {
  AgentFailed,
  DecisionNeeded,
  RoleDenied,
  RunCancelled,
  RunContext,
  isTerminal,
} from "./context.js";
import { readOnlyCheckoutPath, removeCheckout, scriptCheckoutsDir } from "./checkout.js";
import { drivePrePush } from "./prepush.js";
import { retryProblems, tipMovedNotice } from "./retry.js";
import { disposeCheckouts, ensureWholeBase, syncFloorLabels } from "./steps.js";
import { assignRoles } from "./profiles.js";

/** The action doesn't fit the run's status; the API answers `invalid_state`. */
export class InvalidStateError extends Error {
  readonly code = "invalid_state" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateError";
  }
}

/**
 * Checks the roles a run request starts with, as `assign()` checks a role
 * change, and returns them as manual roles. The request schema already
 * holds every role but `reviewer` to one vendor and `reviewer` to at least
 * one. A vendor with no adapter is a `validation` error.
 */
export function startingRoles(
  roles: RoleOverrides | undefined,
  available: readonly Vendor[],
): RoleOverrides {
  if (!roles) return {};
  const named = new Set<Vendor>([
    ...(roles.reviewer ?? []),
    ...(["disprover", "confirmer", "fixer"] as const).flatMap((r) => roles[r] ?? []),
  ]);
  const missing = [...named].filter((v) => !available.includes(v));
  if (missing.length > 0)
    throw new EngineError("validation", `No adapter is configured for ${missing.join(", ")}.`);
  return { ...roles, ...(roles.reviewer ? { reviewer: [...new Set(roles.reviewer)] } : {}) };
}

export interface RunLocation {
  /** The project root; run files go under `<projectRoot>/.aio/runs/<run id>/`. */
  projectRoot: string;
  /** The policy file path relative to the project root, or absolute. */
  policyPath?: string;
}

export class RunController {
  private active: Promise<void> | null = null;
  /** Set when the engine shuts down; see `stopForShutdown()`. */
  private shuttingDown = false;
  /** True while `retry()` checks a run, so a second request can't start it twice. */
  private retrying = false;

  private constructor(
    private readonly ctx: RunContext,
    private readonly location: RunLocation,
  ) {}

  /**
   * Creates a run: resolves the range (throwing `RangeError` with code
   * `dirty_tree` for a dirty tree), loads the policy, and writes the run
   * directory. The run starts with `start()`.
   */
  static async create(
    input: z.input<typeof EngineRunCreateSchema> | EngineRunCreate,
    location: RunLocation,
    deps: EngineDeps,
  ): Promise<RunController> {
    const create = EngineRunCreateSchema.parse(input);
    const { runId, ...fields } = create;
    // Only a stored run lacks the field. It keeps each vendor's configured model, or takes
    // the safe fallback where a CLI default could be a blocked model.
    const request = { ...fields, modelTier: fields.modelTier ?? ("auto" as const) };
    const available = (["claude", "codex", "copilot"] as const).filter((v) => deps.adapters[v]);
    const manual = startingRoles(request.roles, available);
    const clock = deps.clock ?? systemClock;
    const policy = await loadPolicy(location.projectRoot, location.policyPath);
    // The run directory goes under `.aio/`, which is inside the
    // working tree when the project root is the repository. The dirty-tree
    // check skips it too, so a failure here only leaves it in `git status`.
    await new Git(deps.runner, request.repoPath).excludeEngineDir().catch(() => false);
    const range = await resolveRange(
      deps.runner,
      {
        repoPath: request.repoPath,
        base: request.base,
        tip: request.tip,
        mergeBase: request.mergeBase,
        exactBase: request.exactBase,
        scope: request.scope,
        readOnly: request.readOnly,
        includeWorktree: request.includeWorktree,
        prNumber: request.prNumber,
      },
      deps.github,
    );
    const now = new Date(clock.now()).toISOString();
    const state: RunState = {
      id: runId,
      projectId: request.projectId,
      ...(request.boxId ? { boxId: request.boxId } : {}),
      container: deps.container,
      request,
      status: "pending",
      stage: "preflight",
      round: 0,
      baseSha: range.baseSha,
      tipSha: range.tipSha,
      profile: request.profile,
      roles: assignRoles({
        profile: request.profile,
        round: 1,
        available,
        manual,
        crossVendor: request.crossVendor,
      }),
      stopReason: null,
      decision: null,
      ...(request.prNumber ? { prNumber: request.prNumber } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const eng = newEngineState();
    // The request's roles hold like roles a person assigns, until a profile switch.
    eng.manualRoles = manual;
    eng.tipRef = range.tipRef;
    eng.diffBaseSha = range.diffBaseSha;
    eng.includeWorktree = range.includeWorktree;
    eng.phase = request.pipeline;
    const store = new RunStore(location.projectRoot, runId);
    const ctx = new RunContext(state, eng, [], store, deps, policy);
    ctx.extras = await loadPolicyExtras(location.projectRoot, location.policyPath);
    await ctx.persist();
    await ctx.emitRun();
    return new RunController(ctx, location);
  }

  /** Loads a run from its directory, at the stage and status it was left in. */
  static async load(
    runId: string,
    location: RunLocation,
    deps: EngineDeps,
  ): Promise<RunController> {
    const store = new RunStore(location.projectRoot, runId);
    const state = await store.loadState();
    const eng = await store.loadEngineState();
    const findings = await store.loadFindings();
    // The policy is read again each time the driver starts, so a typo in it
    // fails only the runs that go on, and only until it's fixed.
    const ctx = new RunContext(state, eng, findings, store, deps, DEFAULT_POLICY);
    // Checkouts left by an engine that stopped mid-run are stale.
    const git = new Git(deps.runner, state.request.repoPath);
    await removeBaseWorktree(git, baseWorktreePath(runId));
    await removeCheckout(git, readOnlyCheckoutPath(runId));
    await removeCheckout(git, scriptCheckoutsDir(runId));
    return new RunController(ctx, location);
  }

  get id(): string {
    return this.ctx.state.id;
  }

  get runDir(): string {
    return this.ctx.store.dir;
  }

  /** The run's status, without copying the state. */
  get status(): RunState["status"] {
    return this.ctx.state.status;
  }

  /** A copy of the run's state. */
  get state(): RunState {
    return structuredClone(this.ctx.state);
  }

  get findings(): Finding[] {
    return structuredClone(this.ctx.findings);
  }

  async groups(): Promise<FileGroup[]> {
    return (await this.ctx.store.loadGroups()) ?? [];
  }

  async rounds(): Promise<RoundSummary[]> {
    return this.ctx.store.loadRounds();
  }

  /** True while the driver is working on the run. */
  get running(): boolean {
    return this.active !== null;
  }

  /** Resolves when the driver stops: finished, failed, cancelled, or waiting for a decision. */
  async settled(): Promise<RunState> {
    while (this.active) await this.active;
    return this.state;
  }

  /**
   * Starts or continues the run from its current stage. A run left
   * `running` by a stopped engine continues where it was; a failed run
   * retries the stage that failed.
   */
  start(): Promise<RunState> {
    const status = this.ctx.state.status;
    if (status === "waiting_decision") throw new InvalidStateError("The run waits for a decision.");
    if (status === "finished" || status === "cancelled")
      throw new InvalidStateError(`The run is ${status}.`);
    if (status === "paused" && !this.active) this.ctx.requestResume();
    this.drive();
    return Promise.resolve(this.state);
  }

  private drive(): void {
    if (this.active) return;
    const ctx = this.ctx;
    this.active = (async () => {
      try {
        await ctx.beginDrive();
        ctx.policy = await loadPolicy(this.location.projectRoot, this.location.policyPath);
        ctx.extras = await loadPolicyExtras(this.location.projectRoot, this.location.policyPath);
        await ensureWholeBase(ctx);
        if (ctx.state.status !== "running") {
          await ctx.setStatus("running", {
            error: undefined,
            stopReason: null,
            decision: null,
            finishedAt: undefined,
            pausedUntil: undefined,
          });
        }
        if (ctx.eng.phase === "pre-push") await drivePrePush(ctx);
        if (ctx.eng.phase === "post-push" && ctx.state.status === "running")
          await drivePostPush(ctx);
      } catch (error) {
        await this.stopOn(error);
      } finally {
        this.active = null;
      }
    })().catch((error: unknown) => {
      // `stopOn` doesn't reject; this keeps a bug there from crashing the engine.
      ctx.deps.log?.error("The run driver failed", { runId: ctx.state.id, error: String(error) });
    });
  }

  /**
   * Marks the run as stopping with the engine. The driver then fails no
   * stage for the errors that shutting down causes, such as the lease
   * broker rejecting a pending request: the run stays `running` in its run
   * directory, and the next engine continues it, as after a crash. Returns
   * once the driver has stopped or after `waitMs`, whichever comes first.
   */
  async stopForShutdown(waitMs: number): Promise<void> {
    this.shuttingDown = true;
    if (!this.active) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.settled(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  }

  /** Records why the driver stopped. Never rejects, even when the run directory can't be written. */
  private async stopOn(error: unknown): Promise<void> {
    const ctx = this.ctx;
    if (
      this.shuttingDown &&
      !(error instanceof DecisionNeeded) &&
      !(error instanceof RunCancelled) &&
      !ctx.cancelled
    ) {
      ctx.deps.log?.warn("The run stopped with the engine; the next engine continues it", {
        runId: ctx.state.id,
        stage: ctx.state.stage,
        error: (error as Error)?.message ?? String(error),
      });
      return;
    }
    ctx.stopCalls();
    await disposeCheckouts(ctx).catch(() => undefined);
    if (error instanceof DecisionNeeded) {
      await ctx.settleStatus("waiting_decision", { decision: error.decision });
    } else if (error instanceof RunCancelled || ctx.cancelled) {
      await ctx.settleStatus("cancelled", { stopReason: "cancelled" });
    } else {
      const message =
        error instanceof AgentFailed || error instanceof RoleDenied
          ? error.message
          : `The ${ctx.state.stage} stage failed: ${(error as Error)?.message ?? String(error)}`;
      await ctx.settleStatus("failed", { stopReason: "error", error: message });
    }
  }

  /** Refuses a change to a run that can't go on. A failed run can, through a retry. */
  private requireOpen(action: string): void {
    const status = this.ctx.state.status;
    if (status === "finished" || status === "cancelled") {
      throw new InvalidStateError(`Can't ${action}: the run is ${status}.`);
    }
  }

  private requireLive(action: string): void {
    if (isTerminal(this.ctx.state.status)) {
      throw new InvalidStateError(`Can't ${action}: the run is ${this.ctx.state.status}.`);
    }
  }

  /** Pauses after the current agent call. */
  async pause(): Promise<RunState> {
    const status = this.ctx.state.status;
    if (status !== "running" && status !== "pending")
      throw new InvalidStateError(`Can't pause a ${status} run.`);
    this.ctx.requestPause();
    if (!this.active) await this.ctx.setStatus("paused");
    return this.state;
  }

  /** Resumes a paused run. */
  async resume(): Promise<RunState> {
    if (this.ctx.state.status !== "paused")
      throw new InvalidStateError(`Can't resume a ${this.ctx.state.status} run.`);
    // A resume ends a person's pause and every timed wait, since both can
    // overlap. A person who bought a reset can end the wait; a vendor still
    // at its limit only pauses the run again.
    this.ctx.clearVendorLimits();
    this.ctx.wakePause();
    this.ctx.requestResume();
    if (!this.active) this.drive();
    return this.state;
  }

  /** Cancels the run and stops the agent call in flight. */
  async cancel(): Promise<RunState> {
    this.requireLive("cancel");
    this.ctx.requestCancel();
    if (this.active) await this.settled();
    else {
      await disposeCheckouts(this.ctx).catch(() => undefined);
      await this.ctx.setStatus("cancelled", { stopReason: "cancelled" });
    }
    return this.state;
  }

  /** Switches the profile from the next round. */
  async setProfile(profile: Profile): Promise<RunState> {
    this.requireOpen("switch the profile");
    this.ctx.eng.pendingProfile = profile;
    await this.ctx.persist();
    return this.state;
  }

  /** Gives a role to vendors from now on. Only `reviewer` takes more than one. */
  async assign(role: Role, vendors: Vendor[]): Promise<RunState> {
    this.requireOpen("assign a role");
    if (vendors.length === 0) throw new InvalidStateError("Name at least one vendor.");
    if (role !== "reviewer" && vendors.length > 1)
      throw new InvalidStateError(`The ${role} role takes one vendor.`);
    const missing = vendors.filter((v) => !this.ctx.deps.adapters[v]);
    if (missing.length > 0)
      throw new InvalidStateError(`No adapter is configured for ${missing.join(", ")}.`);
    await this.ctx.assignNow(role, vendors);
    return this.state;
  }

  /** Re-resolves the base before the next round. */
  async rebaseBase(): Promise<RunState> {
    this.requireLive("re-resolve the base");
    this.ctx.eng.pendingRebase = true;
    await this.ctx.persist();
    return this.state;
  }

  /** Answers the decision the run waits for, and continues unless the answer is cancel. */
  async decide(answer: DecisionAnswer): Promise<RunState> {
    const ctx = this.ctx;
    const decision = ctx.state.decision;
    if (ctx.state.status !== "waiting_decision" || !decision) {
      throw new InvalidStateError("The run doesn't wait for a decision.");
    }
    if (!decision.options.includes(answer.option)) {
      throw new InvalidStateError(`The decision doesn't offer ${answer.option}.`);
    }
    if (answer.option === "cancel") {
      await ctx.setStatus("cancelled", { stopReason: "cancelled", decision: null });
      return this.state;
    }
    if (decision.kind === "oscillation") {
      const fixed = decision.findingIds.filter((id) => ctx.findingById(id)?.verdict === "fixed");
      ctx.eng.acceptedOscillations = [...new Set([...ctx.eng.acceptedOscillations, ...fixed])];
    }
    if (decision.kind === "gate_failed") {
      ctx.eng.gateAttempts = 0;
      ctx.eng.fixEpoch += 1;
      if (ctx.eng.phase === "post-push" && ctx.state.stage === "import") await ctx.setStage("push");
    }
    if (decision.kind === "push_blocked") ctx.eng.reviewRequestedFor = null;
    if (answer.option === "resume_waive") {
      const ids =
        answer.waiveFindingIds.length > 0
          ? answer.waiveFindingIds
          : decision.findingIds.filter((id) => ctx.findingById(id)?.verdict !== "fixed");
      for (const id of ids) {
        const f = ctx.findingById(id);
        if (!f) throw new InvalidStateError(`The run has no finding ${id}.`);
        await ctx.setVerdict(
          f,
          "waived",
          { kind: "human" },
          answer.reason ?? "Waived in a decision.",
        );
      }
    }
    if (decision.kind === "ceiling") ctx.clearVendorLimits();
    ctx.state.decision = null;
    // A pause asked for before the run stopped for this decision is
    // answered by the decision; it must not pause the run right after.
    ctx.requestResume();
    await ctx.persist();
    this.drive();
    return this.state;
  }

  /**
   * Resumes a failed run from its saved state, at the stage that failed.
   * Saved calls answer from their files. The options apply only after every
   * check passes, so a refused retry changes nothing.
   */
  async retry(options: RunRetry = {}): Promise<RunState> {
    const ctx = this.ctx;
    const status = ctx.state.status;
    if (status === "cancelled") throw new InvalidStateError("A cancelled run is final.");
    if (status !== "failed" || this.active || this.retrying) {
      throw new InvalidStateError(`Can't retry a ${status} run; only a failed run can retry.`);
    }
    this.retrying = true;
    try {
      const finish = options.finishWithClaude === true;
      if (finish && !ctx.availableVendors.includes("claude")) {
        throw new InvalidStateError("Can't finish with Claude: no Claude adapter is configured.");
      }
      const roles = startingRoles(
        finish
          ? { ...options.roles, reviewer: ["claude"], disprover: "claude", fixer: "claude" }
          : options.roles,
        ctx.availableVendors,
      );
      const floor =
        options.verifyFloor === undefined
          ? ctx.state.request.verifyFloor
          : options.verifyFloor === "all"
            ? undefined
            : options.verifyFloor;
      const problems = await retryProblems(
        ctx,
        floor,
        finish ? false : ctx.state.request.crossVendor,
      );
      if (problems.length > 0) {
        throw new InvalidStateError(`Can't retry this run: ${problems.join(" ")}`);
      }
      const notices = [
        `Retried from the ${ctx.state.stage} stage after: ${ctx.state.error ?? "an unknown error"}`,
        ...(await tipMovedNotice(ctx)),
        ...(finish
          ? ["Claude finishes this run with the cross-vendor rule off, so it checks its own work."]
          : []),
      ];
      if (finish) ctx.state.request.crossVendor = false;
      for (const f of ctx.findings) delete f.followUpReason;
      if (floor) ctx.state.request.verifyFloor = floor;
      else delete ctx.state.request.verifyFloor;
      ctx.clearVendorLimits();
      ctx.requestResume();
      for (const [role, vendors] of Object.entries(roles) as [Role, Vendor | Vendor[]][]) {
        await ctx.assignNow(role, Array.isArray(vendors) ? vendors : [vendors]);
      }
      await ctx.refreshRoles();
      await syncFloorLabels(ctx);
      await ctx.setStatus("running", {
        error: undefined,
        stopReason: null,
        decision: null,
        finishedAt: undefined,
        pausedUntil: undefined,
        notices: [...(ctx.state.notices ?? []), ...notices],
      });
      this.drive();
      return this.state;
    } finally {
      this.retrying = false;
    }
  }

  /** Waives one finding outside a decision. */
  async waive(findingId: string, reason: string): Promise<Finding> {
    const f = this.ctx.findingById(findingId);
    if (!f) throw new InvalidStateError(`The run has no finding ${findingId}.`);
    await this.ctx.setVerdict(f, "waived", { kind: "human" }, reason);
    return structuredClone(f);
  }

  /** Starts the post-push loop after a finished pre-push run. */
  async push(options: { title?: string; draft?: boolean } = {}): Promise<RunState> {
    const ctx = this.ctx;
    if (ctx.state.request.readOnly) throw new InvalidStateError("A read-only run can't push.");
    if (!ctx.deps.github) throw new InvalidStateError("The post-push loop needs the gh client.");
    if (this.active || ctx.state.status !== "finished") {
      throw new InvalidStateError(`Can't push a ${ctx.state.status} run.`);
    }
    if (
      ctx.state.status === "finished" &&
      ctx.state.stopReason !== "clean" &&
      ctx.state.stopReason !== "clean_above_floor" &&
      ctx.state.stopReason !== "clean_with_followups" &&
      ctx.state.stopReason !== "round_cap"
    ) {
      throw new InvalidStateError(
        `Can't push a run that stopped with ${ctx.state.stopReason ?? "no reason"}.`,
      );
    }
    ctx.eng.phase = "post-push";
    ctx.eng.postPushStartRound = ctx.state.round;
    ctx.eng.push = { title: options.title ?? null, draft: options.draft ?? false };
    ctx.eng.roundOpen = false;
    ctx.state.decision = null;
    ctx.state.finishedAt = undefined;
    await ctx.setStage("push");
    this.drive();
    return this.state;
  }
}

/** The run directory of a run, relative to the project root. */
export function runDirFor(runId: string): string {
  return `${RUNS_DIR}/${runId}`;
}
