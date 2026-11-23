// The build controller: one per build. It creates the build's files and
// worktree, drives the build pipeline step by step, and handles the build
// requests: pause and resume. Its drive saves after every step, so a
// restarted engine continues the build from where it stopped.
import { mkdir } from "node:fs/promises";
import type { BuildCreate, BuildPlan, BuildState, BuildStep } from "@aio/contracts";
import { RunCancelled, describeError } from "../calls/index.js";
import { EngineError } from "../api/core-interface.js";
import { loadPolicy } from "../policy/load.js";
import { BuildContext, type BuildServices } from "./context.js";
import { ulid } from "./ids.js";
import { loadRoles, type LoadRolesOptions } from "./roles/index.js";
import { BUILD_PIPELINE, STEP_HANDLERS, type StepHandler } from "./steps/index.js";
import { checkPlan } from "./plan-check.js";
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
        if ((await handler(ctx)) === "wait") return;
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

  /** Pauses the build after its current agent call or gate. */
  async pause(): Promise<BuildState> {
    if (this.state.status !== "running") {
      throw new EngineError(
        "invalid_state",
        `Build ${this.slug} is ${this.state.status}, not running.`,
      );
    }
    this.ctx.calls.requestPause();
    await this.ctx.setStatus("paused");
    return this.state;
  }

  /** Resumes a paused build. */
  async resume(): Promise<BuildState> {
    if (this.state.status !== "paused") {
      throw new EngineError(
        "invalid_state",
        `Build ${this.slug} is ${this.state.status}, not paused.`,
      );
    }
    await this.ctx.setStatus("running");
    this.ctx.calls.requestResume();
    this.ctx.calls.wakePause();
    this.start();
    return this.state;
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
