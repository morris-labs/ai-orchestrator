// The build controller: one per build. It creates the build's files and
// worktree, drives the build pipeline step by step, and handles the build
// requests: pause, resume, resolve, cancel, delete, and owner posts. Its drive
// saves after every step, so a restarted engine continues the build from
// where it stopped.
import { mkdir, rm } from "node:fs/promises";
import type {
  BuildCreate,
  BuildDecision,
  BuildPlan,
  BuildPauseReason,
  BuildState,
  BuildStatus,
  BuildStep,
  EscalationResolve,
  Message,
  OwnerPost,
  OwnerPostAnswer,
  RunState,
} from "@aio/contracts";
import { RunCancelled, describeError } from "../calls/index.js";
import { MessageRefused } from "../team/index.js";
import { isDirectMessage } from "./owner/index.js";
import { EngineError } from "../api/core-interface.js";
import { loadPolicy } from "../policy/load.js";
import { writeClosingRecord } from "./closing-record.js";
import { BuildContext, type BuildServices } from "./context.js";
import { ulid } from "./ids.js";
import { loadRoles, type LoadRolesOptions } from "./roles/index.js";
import { BUILD_PIPELINE, STEP_HANDLERS, type StepHandler } from "./steps/index.js";
import { checkPlan } from "./plan-check.js";
import { resolveEscalation } from "./resolve.js";
import { BuildStore } from "./store.js";
import { BuildWorktree } from "./worktree.js";

/** Where a build lives and what it runs on. */
export interface BuildLocation {
  projectRoot: string;
  container: string;
  /** The policy file, for its tier models. */
  policyPath?: string;
  /** Options for loading role definitions, such as a test role library. */
  roles?: LoadRolesOptions;
}

/** What a build that planning started keeps from its planning record. */
export interface BuildOrigin {
  id: string;
  createdAt: string;
  boxId: string | null;
}

/** The steps a controller runs, in order, and their handlers. Tests and later milestones pass their own. */
export interface BuildPipeline {
  steps: readonly BuildStep[];
  handlers: Partial<Record<BuildStep, StepHandler>>;
}

const DEFAULT_PIPELINE: BuildPipeline = { steps: BUILD_PIPELINE, handlers: STEP_HANDLERS };

/** Statuses a build can be deleted in: nothing runs, and nothing waits to run. */
const DELETABLE: readonly BuildStatus[] = ["finished", "failed", "cancelled"];

/** Review run statuses that a build pause or cancel reaches. */
const LIVE_RUN: readonly RunState["status"][] = [
  "pending",
  "running",
  "paused",
  "waiting_decision",
];

async function servicesFor(
  location: BuildLocation,
  services: Omit<BuildServices, "tierModels" | "sessions">,
): Promise<BuildServices> {
  const policy = await loadPolicy(location.projectRoot, location.policyPath);
  return {
    ...services,
    ...(policy.tierModels ? { tierModels: policy.tierModels } : {}),
    ...(policy.sessions ? { sessions: policy.sessions } : {}),
  };
}

export class BuildController {
  private driver: Promise<void> | null = null;
  /** True while the engine shuts down: a stopped drive leaves the build as it is. */
  private stopping = false;
  /** True when a resolution came in during a drive: another drive follows it. */
  private again = false;
  /** True while a cancel stops the drive: the drive leaves the status to the cancel. */
  private cancelling = false;
  /** The closing record under way after a cancel. */
  private closing: Promise<void> | null = null;

  private constructor(
    readonly ctx: BuildContext,
    private readonly log: BuildServices["log"],
    private readonly pipeline: BuildPipeline,
  ) {}

  get state(): BuildState {
    return this.ctx.state;
  }

  get slug(): string {
    return this.ctx.state.slug;
  }

  /** True while a drive is under way. */
  get running(): boolean {
    return this.driver !== null;
  }

  /**
   * Creates a build: its directory, plan, state, branch, and worktree.
   * Throws `WorktreeConflict` when the branch or the worktree exists. A
   * build that planning started keeps the id, creation time, and box of
   * its planning record in `origin`.
   */
  static async create(
    request: BuildCreate & { plan: BuildPlan },
    location: BuildLocation,
    services: Omit<BuildServices, "tierModels" | "sessions">,
    pipeline: BuildPipeline = DEFAULT_PIPELINE,
    origin?: BuildOrigin,
  ): Promise<BuildController> {
    const repoPath = request.repoPath ?? location.projectRoot;
    const branch = BuildWorktree.branchFor(request.slug);
    const worktree = new BuildWorktree(
      services.runner,
      repoPath,
      BuildWorktree.pathFor(repoPath, request.slug),
      branch,
    );
    const roles = await loadRoles(repoPath, location.roles);
    await checkPlan(request.plan, roles, { repoRoot: repoPath, skillDirs: services.skillDirs() });
    const full = await servicesFor(location, services);
    const base = await worktree.resolveBase(request.base);
    await worktree.create(base);
    const store = new BuildStore(location.projectRoot, request.slug);
    await mkdir(store.scratchDir, { recursive: true });
    const now = new Date(services.clock.now()).toISOString();
    const state: BuildState = {
      version: 1,
      id: origin?.id ?? ulid(services.clock.now()),
      slug: request.slug,
      projectId: request.projectId,
      boxId: request.boxId ?? origin?.boxId ?? null,
      container: location.container,
      title: request.plan.title,
      repoPath,
      base,
      branch,
      worktree: worktree.path,
      status: "running",
      step: pipeline.steps[0] ?? "tasks",
      tasks: request.plan.tasks.map((t) => ({
        id: t.id,
        status: "pending",
        attempts: 0,
        commit: null,
      })),
      escalations: [],
      placements: {
        singleVendor: request.plan.singleVendor,
        plan: request.plan.placements,
        live: [],
      },
      createdAt: origin?.createdAt ?? now,
      updatedAt: now,
    };
    await store.savePlan(request.plan);
    // Planning's calls took lease and agent ids already; execution goes on from them.
    const ledger = await store.loadLedger();
    const ctx = new BuildContext(state, request.plan, ledger, store, worktree, roles, full);
    await ctx.persist();
    return new BuildController(ctx, services.log, pipeline);
  }

  /** Loads a build from its files. Throws `BuildNotFoundError` when it has none. */
  static async load(
    slug: string,
    location: BuildLocation,
    services: Omit<BuildServices, "tierModels" | "sessions">,
    pipeline: BuildPipeline = DEFAULT_PIPELINE,
  ): Promise<BuildController> {
    const store = new BuildStore(location.projectRoot, slug);
    const state = await store.loadState();
    const plan = await store.loadPlan();
    const ledger = await store.loadLedger();
    const worktree = new BuildWorktree(
      services.runner,
      state.repoPath,
      state.worktree,
      state.branch,
    );
    const roles = await loadRoles(state.repoPath, location.roles);
    const full = await servicesFor(location, services);
    const ctx = new BuildContext(state, plan, ledger, store, worktree, roles, full);
    return new BuildController(ctx, services.log, pipeline);
  }

  /** Starts a drive unless one is under way. */
  start(): void {
    if (this.driver) return;
    this.stopping = false;
    this.driver = this.drive().finally(() => {
      this.driver = null;
      if (this.again && !this.stopping) {
        this.again = false;
        // A pause or a new escalation without a task that came in meanwhile holds the build.
        if (this.resumable()) this.start();
      }
    });
  }

  private async drive(): Promise<void> {
    const { ctx } = this;
    try {
      await ctx.beginDrive();
      await ctx.worktree.ensure();
      if (ctx.state.status !== "running") await ctx.setStatus("running");
      // Messages that a stopped engine or drive left waiting get their turns.
      ctx.sessions.resumePending();
      for (;;) {
        await ctx.calls.checkpoint();
        const step = ctx.state.step;
        const handler = this.pipeline.handlers[step];
        if (!handler) {
          await ctx.setStatus(
            "paused",
            `The build waits at the ${step} step, which this engine version doesn't run yet.`,
          );
          return;
        }
        if ((await handler(ctx)) === "wait") {
          // A step that left the build running with escalations open waits for them.
          if (ctx.state.status === "running" && ctx.openEscalations().length > 0) {
            await ctx.waitForEscalations();
          }
          return;
        }
        // A step ends when its agents' conversations do: the message turns
        // it started finish before the next step.
        await ctx.sessions.idle();
        await ctx.calls.checkpoint();
        const next = this.pipeline.steps[this.pipeline.steps.indexOf(step) + 1];
        if (!next) {
          // The last step's note, such as where its digest is, stays.
          await ctx.setStatus("finished", ctx.state.note);
          return;
        }
        await ctx.setStep(next);
      }
    } catch (error) {
      await this.stopOn(error);
    }
  }

  /** Records why a drive stopped. A shutdown leaves the build `running`, for the next engine. */
  private async stopOn(error: unknown): Promise<void> {
    if (this.cancelling) return;
    if (this.stopping && error instanceof RunCancelled) return;
    if (this.stopping) {
      this.log.warn("A build stopped with an error while the engine shut down", {
        build: this.slug,
        error: describeError(error),
      });
      return;
    }
    this.log.error("A build failed", { build: this.slug, error: describeError(error) });
    try {
      await this.ctx.setStatus("failed", `The engine stopped the build: ${describeError(error)}`);
    } catch (saveError) {
      this.log.error("Couldn't record a failed build", {
        build: this.slug,
        error: String(saveError),
      });
    }
  }

  /**
   * Pauses the build after its current agent call or gate, and its review
   * run. `reason` records who paused it: a box start resumes only a build
   * that its box's stop paused. A build in a timed pause, such as a wait for
   * a vendor's limit reset, takes the pause too, so it doesn't wake on its
   * own when the wait ends. So does a build that waits for an escalation,
   * so a resolution doesn't resume it until the resume.
   */
  async pause(reason: BuildPauseReason = "owner"): Promise<BuildState> {
    this.requireLive("pause");
    const { status, pausedUntil, pausedBy } = this.state;
    const timed = status === "paused" && pausedUntil !== undefined && pausedBy === undefined;
    if (status !== "running" && status !== "waiting_escalation" && !timed) {
      throw new EngineError("invalid_state", `Build ${this.slug} is ${status}, not running.`);
    }
    this.ctx.calls.requestPause();
    this.ctx.state.pausedBy = reason;
    // The pause lasts until a resume, not until the timed wait ends.
    delete this.ctx.state.pausedUntil;
    await this.ctx.setStatus("paused");
    await this.reviewRun("pause", ["running", "pending"]);
    return this.state;
  }

  /**
   * Resumes a paused build, or a cancelled one, and its review run. With
   * `reason` `box`, resumes only a build that a box stop paused.
   */
  async resume(reason: BuildPauseReason = "owner"): Promise<BuildState> {
    this.requireLive("resume");
    const { status } = this.state;
    if (status === "cancelled" && reason === "owner") return this.resumeCancelled();
    if (status !== "paused") {
      throw new EngineError("invalid_state", `Build ${this.slug} is ${status}, not paused.`);
    }
    if (reason === "box" && this.state.pausedBy !== "box") {
      throw new EngineError(
        "invalid_state",
        `Build ${this.slug} wasn't paused by its box's stop, so the box start leaves it paused.`,
      );
    }
    this.ctx.calls.requestResume();
    this.ctx.calls.wakePause();
    // An open escalation without a task still holds the build: its step
    // doesn't run again until the escalation is resolved.
    if (this.ctx.openEscalations().some((e) => e.taskId === null)) {
      await this.ctx.waitForEscalations();
      return this.state;
    }
    await this.ctx.setStatus("running");
    this.start();
    await this.reviewRun("resume", ["paused"]);
    return this.state;
  }

  /** Starts a cancelled build again from the step it stopped at. */
  private async resumeCancelled(): Promise<BuildState> {
    await this.closing;
    // A cancelled review run never resumes: the review step starts a new one.
    const run = await this.reviewRun();
    if (run?.status === "cancelled" && this.state.step === "review") {
      await rm(this.ctx.store.path("review", "run.json"), { force: true });
    }
    delete this.ctx.state.closingRecord;
    await this.ctx.setStatus("running");
    this.start();
    return this.state;
  }

  /**
   * Cancels the build: stops every agent and the gate's commands, cancels
   * its review run, and keeps the branch and the worktree. The Scribe then
   * writes the closing record; `closingRecord` names it once it's written.
   */
  async cancel(): Promise<BuildState> {
    this.requireLive("cancel");
    const { status, step } = this.state;
    if (status === "finished" || status === "cancelled") {
      throw new EngineError("invalid_state", `Build ${this.slug} is ${status} already.`);
    }
    this.cancelling = true;
    try {
      this.ctx.calls.requestCancel();
      this.ctx.stopDrive();
      await this.driver;
    } finally {
      this.cancelling = false;
    }
    await this.reviewRun("cancel", LIVE_RUN);
    this.ctx.renewCalls();
    const why = `The owner cancelled the build at the ${step} step.`;
    await this.ctx.setStatus("cancelled", `${why} The branch and the worktree stay.`);
    this.closeRecord(why);
    return this.state;
  }

  /** Writes the closing record of a cancelled build that has none, such as after an engine restart. */
  finishClosing(): void {
    if (this.state.status !== "cancelled" || this.state.closingRecord || this.state.deletedAt) {
      return;
    }
    this.closeRecord(`The owner cancelled the build at the ${this.state.step} step.`);
  }

  private closeRecord(why: string): void {
    if (this.closing) return;
    this.closing = writeClosingRecord(this.ctx, why)
      .catch((error: unknown) => {
        this.log.error("Couldn't write a build's closing record", {
          build: this.slug,
          error: describeError(error),
        });
      })
      .finally(() => {
        this.closing = null;
      });
  }

  /**
   * Deletes a finished, failed, or cancelled build: removes its worktree and
   * its build branch. The build directory, with the plan, the state, and the
   * closing record, stays.
   */
  async delete(): Promise<BuildState> {
    this.requireLive("delete");
    if (!DELETABLE.includes(this.state.status) || this.running) {
      throw new EngineError(
        "invalid_state",
        `Build ${this.slug} is ${this.state.status}. Cancel it before you delete it.`,
      );
    }
    await this.closing;
    await this.ctx.worktree.destroy();
    this.ctx.state.deletedAt = new Date(this.ctx.services.clock.now()).toISOString();
    this.ctx.state.note =
      "The owner deleted the build: its branch and worktree are gone, and its record stays.";
    await this.ctx.persist();
    return this.state;
  }

  /** Refuses any request on a deleted build. */
  private requireLive(action: string): void {
    if (this.state.deletedAt) {
      throw new EngineError(
        "invalid_state",
        `Build ${this.slug} was deleted, so you can't ${action} it.`,
      );
    }
  }

  /**
   * The build's review run, or `null` when it has none. With `action`, also
   * pauses, resumes, or cancels the run when its status is one of `when`;
   * a run that refuses is logged, since the build's own request went
   * through.
   */
  private async reviewRun(
    action?: "pause" | "resume" | "cancel",
    when: readonly RunState["status"][] = [],
  ): Promise<RunState | null> {
    const runs = this.ctx.services.reviews;
    if (!runs) return null;
    const record = await this.ctx.store.readJson<{ runId: string }>(
      this.ctx.store.path("review", "run.json"),
    );
    if (!record) return null;
    const run = await runs.get(record.runId);
    if (!run || !action || !when.includes(run.status)) return run;
    try {
      return await runs[action](run.id);
    } catch (error) {
      this.log.warn(`Couldn't ${action} a build's review run`, {
        build: this.slug,
        run: run.id,
        error: describeError(error),
      });
      return run;
    }
  }

  /**
   * Resolves one of the build's escalations, or marks it for the owner, and
   * resumes the build when nothing else holds it: no escalation without a
   * task is open, and nobody paused the build. Throws `EngineError` for a
   * request that doesn't fit the escalation.
   */
  async resolve(request: EscalationResolve): Promise<BuildState> {
    if (this.stopping) {
      throw new EngineError("invalid_state", `Build ${this.slug} stops with the engine.`);
    }
    if ((await resolveEscalation(this.ctx, request)) === "owner") return this.state;
    if (!this.resumable()) return this.state;
    if (this.driver) {
      this.again = true;
      return this.state;
    }
    if (this.state.status === "waiting_escalation") await this.ctx.setStatus("running");
    this.start();
    return this.state;
  }

  /**
   * Whether a resolution can resume the build: nobody paused it, and no
   * open escalation without a task holds it.
   */
  private resumable(): boolean {
    const { status } = this.state;
    return (
      (status === "running" || status === "waiting_escalation") &&
      !this.ctx.openEscalations().some((e) => e.taskId === null)
    );
  }

  /**
   * Posts as the owner to one agent of the build. Throws `invalid_state`
   * for a build that ended, `conflict` when the engine runs no team chat,
   * and `validation` for a post the team chat refuses.
   */
  async post(input: OwnerPost): Promise<OwnerPostAnswer> {
    if (["finished", "failed", "cancelled"].includes(this.state.status)) {
      throw new EngineError(
        "invalid_state",
        `Build ${this.slug} is ${this.state.status}, so no agent can take a post.`,
      );
    }
    if (!this.ctx.team) {
      throw new EngineError("conflict", "This engine runs no team chat, so it can't take a post.");
    }
    try {
      return await this.ctx.post(input);
    } catch (error) {
      if (error instanceof MessageRefused) throw new EngineError("validation", error.message);
      throw error;
    }
  }

  /** The build's team chat messages, oldest first; with `direct`, only the ones agents sent the owner. */
  async messages(direct = false): Promise<Message[]> {
    const all = (await this.ctx.team?.list()) ?? [];
    return direct ? all.filter(isDirectMessage) : all;
  }

  /** The build's decisions, oldest first. */
  decisions(): Promise<BuildDecision[]> {
    return this.ctx.decisions.list();
  }

  /**
   * Stops the drive for an engine shutdown and leaves the build's files as
   * they are, so the next engine continues it. Waits up to `waitMs` for the
   * drive to stop.
   */
  async stopForShutdown(waitMs: number): Promise<void> {
    this.stopping = true;
    this.ctx.stopDrive();
    const driver = this.driver;
    if (!driver) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      driver,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }
}
