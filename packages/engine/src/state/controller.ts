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
  type RoundSummary,
  type RunState,
  type Vendor,
} from "@agentbox/contracts";
import type { z } from "zod";
import type { EngineDeps } from "../core.js";
import { systemClock } from "../core.js";
import { DEFAULT_POLICY } from "@agentbox/contracts";
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
import { disposeCheckouts } from "./steps.js";
import { assignRoles } from "./profiles.js";

/** The action doesn't fit the run's status; the API answers `invalid_state`. */
export class InvalidStateError extends Error {
  readonly code = "invalid_state" as const;
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateError";
  }
}

export interface RunLocation {
  /** The project root; run files go under `<projectRoot>/.claude-box/runs/<run id>/`. */
  projectRoot: string;
  /** The policy file path relative to the project root, or absolute. */
  policyPath?: string;
}

export class RunController {
  private active: Promise<void> | null = null;

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
    const { runId, ...request } = create;
    const clock = deps.clock ?? systemClock;
    const policy = await loadPolicy(location.projectRoot, location.policyPath);
    // The run directory goes under `.claude-box/`, which is inside the
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
        readOnly: request.readOnly,
        includeWorktree: request.includeWorktree,
        prNumber: request.prNumber,
      },
      deps.github,
    );
    const now = new Date(clock.now()).toISOString();
    const available = (["claude", "codex", "copilot"] as const).filter((v) => deps.adapters[v]);
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
        crossVendor: request.crossVendor,
      }),
      stopReason: null,
      decision: null,
      ...(request.prNumber ? { prNumber: request.prNumber } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const eng = newEngineState();
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
        ctx.policy = await loadPolicy(this.location.projectRoot, this.location.policyPath);
        ctx.extras = await loadPolicyExtras(this.location.projectRoot, this.location.policyPath);
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

  /** Records why the driver stopped. Never rejects, even when the run directory can't be written. */
  private async stopOn(error: unknown): Promise<void> {
    const ctx = this.ctx;
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
    if (this.ctx.state.pausedUntil && this.active) {
      throw new InvalidStateError(
        `The run waits for a usage limit until ${this.ctx.state.pausedUntil}.`,
      );
    }
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
    this.requireLive("switch the profile");
    this.ctx.eng.pendingProfile = profile;
    await this.ctx.persist();
    return this.state;
  }

  /** Gives a role to vendors from the next round. Only `reviewer` takes more than one. */
  async assign(role: Role, vendors: Vendor[]): Promise<RunState> {
    this.requireLive("assign a role");
    if (vendors.length === 0) throw new InvalidStateError("Name at least one vendor.");
    if (role !== "reviewer" && vendors.length > 1)
      throw new InvalidStateError(`The ${role} role takes one vendor.`);
    const missing = vendors.filter((v) => !this.ctx.deps.adapters[v]);
    if (missing.length > 0)
      throw new InvalidStateError(`No adapter is configured for ${missing.join(", ")}.`);
    this.ctx.eng.pendingAssign.push({ role, vendors });
    await this.ctx.persist();
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
    ctx.state.decision = null;
    // A pause asked for before the run stopped for this decision is
    // answered by the decision; it must not pause the run right after.
    ctx.requestResume();
    await ctx.persist();
    this.drive();
    return this.state;
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
