// The engine build API: the planning requests (a planning seat call, a
// meeting, and the freeze) over one `BuildPlanner` per build, the build
// requests (start, status, pause, resume, resolve, cancel, and delete) over
// one `BuildController` per build, the rule of one active build per box, and
// the startup scan that continues the builds a stopped engine left running.
import {
  BOX_BUILD_STATUSES,
  BuildCreateSchema,
  BuildFreezeRequestSchema,
  BuildMeetingPostRequestSchema,
  BuildMeetingRequestSchema,
  BuildSeatRequestSchema,
  BuildSlugSchema,
  ENGINE_CONFIG_MOUNT,
  EscalationResolveSchema,
  type BuildCreateInput,
  type BuildFreezeAnswer,
  type BuildFreezeRequest,
  type BuildMeetingAnswer,
  type BuildMeetingPostRequest,
  type BuildMeetingRequestInput,
  type BuildPauseReason,
  type BuildPlan,
  type BuildSeatAnswer,
  type BuildSeatRequestInput,
  type BuildDecision,
  type BuildState,
  type EscalationResolveInput,
  type Message,
  type OwnerPostInput,
  type OwnerPostAnswer,
} from "@aio/contracts";
import { OwnerPostSchema } from "@aio/contracts";
import { accountDirsFileIn, readAccountDirs } from "../adapters/account-dirs.js";
import { EngineError, type CoreDeps } from "../api/core-interface.js";
import { systemClock } from "../core.js";
import { PolicyError } from "../policy/load.js";
import { ExecaRunner, ShellRunner } from "../range/exec.js";
import { GitError } from "../range/git.js";
import {
  BuildController,
  type BuildLocation,
  type BuildOrigin,
  type BuildPipeline,
} from "./controller.js";
import type { BuildServices, ReviewRuns } from "./context.js";
import { BuildPlanner, planHash } from "./planning/index.js";
import { RoleError } from "./roles/index.js";
import { accountSkillDirs } from "./specialties/index.js";
import { BuildNotFoundError, BuildStore, listBuildSlugs } from "./store.js";
import { WorktreeConflict } from "./worktree.js";
import type { TeamBus } from "../team/index.js";

/** How long `close()` waits for a build's drive to stop. */
const SHUTDOWN_WAIT_MS = 5000;

/**
 * The build requests. Every method that names a build throws `EngineError`
 * with `not_found` for an unknown build, except `get`, which returns `null`.
 */
export interface BuildManager {
  /**
   * Calls a planning seat and waits for its answer. Starts the build's
   * planning record on its first call. Throws `conflict` once the build runs.
   */
  plan(request: BuildSeatRequestInput): Promise<BuildSeatAnswer>;
  /**
   * Freezes the build plan as its next version, or returns the latest one
   * when the plan hasn't changed. Throws `validation` without the owner's
   * push answer, and `conflict` once the build runs.
   */
  freeze(request: BuildFreezeRequest): Promise<BuildFreezeAnswer>;
  /**
   * Opens a planning meeting and waits until it ends. Throws `conflict`
   * while a seat call or another meeting is under way, and once the build
   * runs.
   */
  meet(request: BuildMeetingRequestInput): Promise<BuildMeetingAnswer>;
  /**
   * Adds an owner post to a meeting under way. Throws `not_found` for an
   * unknown meeting and `conflict` for one that ended.
   */
  meetingPost(request: BuildMeetingPostRequest): Promise<BuildMeetingAnswer>;
  /**
   * Creates a build and starts it, from the request's plan or, absent, the
   * build's latest frozen plan. Throws `conflict` when the build exists, and
   * `validation` for a plan that differs from the frozen one. Throws
   * `conflict` when the request's box already has an active build.
   */
  start(request: BuildCreateInput): Promise<BuildState>;
  get(slug: string): Promise<BuildState | null>;
  /** Pauses a running build; `reason` `box` marks a pause for a box stop. */
  pause(slug: string, reason?: BuildPauseReason): Promise<BuildState>;
  /**
   * Resumes a paused build, or a cancelled one. With `reason` `box`, only a
   * build that a box stop paused. Throws `conflict` when another build holds
   * the box of a cancelled build.
   */
  resume(slug: string, reason?: BuildPauseReason): Promise<BuildState>;
  /** Cancels a build and has the Scribe write its closing record. */
  cancel(slug: string): Promise<BuildState>;
  /** Removes a finished, failed, or cancelled build's branch and worktree, and keeps its record. */
  delete(slug: string): Promise<BuildState>;
  /**
   * Resolves an escalation of the build and resumes what it paused, or marks
   * it for the owner. Throws `not_found` for an unknown escalation,
   * `invalid_state` for a resolved one, and `validation` for a request that
   * doesn't fit it.
   */
  resolve(slug: string, request: EscalationResolveInput): Promise<BuildState>;
  /**
   * Posts as the owner to one agent of build `slug`; only that agent runs.
   * The engine records the post as a decision on its task. Throws
   * `invalid_state` for a build that ended.
   */
  post(slug: string, input: OwnerPostInput): Promise<OwnerPostAnswer>;
  /** The build's team chat messages, oldest first; with `direct`, only the direct messages to the owner. */
  messages(slug: string, options?: { direct?: boolean }): Promise<Message[]>;
  /** The build's decisions, oldest first. */
  decisions(slug: string): Promise<BuildDecision[]>;
  /** The builds that keep the container alive: the ones the engine works on. */
  activeCount(): number;
  /** Stops every drive and leaves each build's files for the next engine. */
  close(): Promise<void>;
}

/** What `createBuildManager()` receives: the run manager's deps, and optional test settings. */
export interface BuildManagerDeps extends CoreDeps {
  /** The account skills folders that hold specialties. Default: the ones the account folders file names. */
  skillDirs?: () => string[];
  /** Options for loading role definitions, such as a test role library. */
  roles?: BuildLocation["roles"];
  /** The steps builds run, for tests and later milestones. */
  pipeline?: BuildPipeline;
  /** The team chat bus that seat calls reach. Without it, they run without one. */
  team?: TeamBus;
  /** The engine's review runs, for the review step. */
  reviews?: ReviewRuns;
  /** How often the review step reads its run's state, in milliseconds. */
  reviewPollMs?: number;
  /** The secret names the project gives builds. Without it, preflight doesn't check the plan's secrets. */
  secretNames?: () => Promise<string[]>;
}

/** Turns a creation error into one the API maps to a status. */
function toApiError(error: unknown): unknown {
  if (error instanceof WorktreeConflict) return new EngineError("conflict", error.message);
  if (error instanceof GitError || error instanceof PolicyError || error instanceof RoleError) {
    return new EngineError("validation", error.message);
  }
  return error;
}

export class EngineBuildManager implements BuildManager {
  private readonly controllers = new Map<string, BuildController>();
  private readonly loading = new Map<string, Promise<BuildController | null>>();
  private readonly planners = new Map<string, Promise<BuildPlanner | null>>();
  /** The planners this engine opened, whose seat calls keep the container alive. */
  private readonly openPlanners = new Set<BuildPlanner>();
  private readonly services: Omit<BuildServices, "tierModels">;
  private readonly location: BuildLocation;
  /** Serializes the requests that check a box's builds, so two starts can't both take a box. */
  private boxChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: BuildManagerDeps) {
    const runner = deps.runner ?? new ExecaRunner();
    const clock = deps.clock ?? systemClock;
    this.services = {
      call: {
        adapters: deps.adapters,
        broker: deps.leases,
        runner,
        clock,
        log: deps.log,
        ...(deps.models ? { models: deps.models } : {}),
      },
      events: deps.events,
      runner,
      shell: new ShellRunner(runner),
      skillDirs:
        deps.skillDirs ??
        (() => accountSkillDirs(readAccountDirs(accountDirsFileIn(ENGINE_CONFIG_MOUNT)))),
      clock,
      log: deps.log,
      ...(deps.team ? { team: deps.team } : {}),
      ...(deps.reviews ? { reviews: deps.reviews } : {}),
      ...(deps.reviewPollMs !== undefined ? { reviewPollMs: deps.reviewPollMs } : {}),
      ...(deps.secretNames ? { secretNames: deps.secretNames } : {}),
    };
    this.location = {
      projectRoot: deps.projectRoot,
      container: deps.container,
      ...(deps.policyPath ? { policyPath: deps.policyPath } : {}),
      ...(deps.roles ? { roles: deps.roles } : {}),
    };
  }

  /**
   * Continues every build that a stopped engine left running, or paused until
   * a vendor's limit resets. A build that can't be loaded is skipped and
   * logged, so one bad build directory never keeps the engine from starting.
   */
  async init(): Promise<void> {
    for (const slug of await listBuildSlugs(this.deps.projectRoot)) {
      let state: BuildState;
      try {
        state = await new BuildStore(this.deps.projectRoot, slug).loadState();
      } catch (error) {
        // A build in planning has no state until it starts.
        if (error instanceof BuildNotFoundError) continue;
        this.deps.log.warn("Skipped a build whose state can't be read", {
          build: slug,
          error: String(error),
        });
        continue;
      }
      if (state.status === "cancelled" && !state.closingRecord && !state.deletedAt) {
        // The engine stopped before the closing record was written.
        await this.controller(slug)
          .then((build) => build?.finishClosing())
          .catch((error: unknown) => {
            this.deps.log.warn("Couldn't write a build's closing record", {
              build: slug,
              error: String(error),
            });
          });
        continue;
      }
      const due = state.status === "running" || (state.status === "paused" && state.pausedUntil);
      if (!due) continue;
      try {
        const build = await this.controller(slug);
        this.deps.log.info("Continuing a build the engine left unfinished", {
          build: slug,
          step: state.step,
        });
        build?.start();
      } catch (error) {
        this.deps.log.warn("Couldn't continue a build", { build: slug, error: String(error) });
      }
    }
  }

  private controller(slug: string): Promise<BuildController | null> {
    const live = this.controllers.get(slug);
    if (live) return Promise.resolve(live);
    if (!BuildSlugSchema.safeParse(slug).success) return Promise.resolve(null);
    let pending = this.loading.get(slug);
    if (!pending) {
      pending = (async () => {
        try {
          const build = await BuildController.load(
            slug,
            this.location,
            this.services,
            this.deps.pipeline,
          );
          this.controllers.set(slug, build);
          return build;
        } catch (error) {
          if (error instanceof BuildNotFoundError) return null;
          throw error;
        } finally {
          this.loading.delete(slug);
        }
      })();
      this.loading.set(slug, pending);
    }
    return pending;
  }

  private async require(slug: string): Promise<BuildController> {
    const build = await this.controller(slug);
    if (!build) throw new EngineError("not_found", `No build ${slug}.`);
    return build;
  }

  /** The planner of build `slug`, loaded once, or `null` when planning never started. */
  private planner(slug: string): Promise<BuildPlanner | null> {
    let planner = this.planners.get(slug);
    if (!planner) {
      planner = BuildPlanner.load(slug, this.location, this.services);
      this.planners.set(slug, planner);
      planner.catch(() => this.planners.delete(slug));
    }
    return planner;
  }

  /** The planner of build `slug`, started for the request's project when planning never started. */
  private async openPlanner(request: {
    slug: string;
    projectId: string;
    boxId: string | null;
  }): Promise<BuildPlanner> {
    const { slug } = request;
    if (this.loading.has(slug) || (await this.controller(slug))) {
      throw new EngineError("conflict", `Build ${slug} runs already, so its planning is over.`);
    }
    let planner = await this.planner(slug);
    if (!planner) {
      const creating = BuildPlanner.create(request, this.location, this.services);
      this.planners.set(slug, creating);
      creating.catch(() => this.planners.delete(slug));
      planner = await creating;
    }
    if (planner.record.projectId !== request.projectId) {
      throw new EngineError("not_found", `Project ${request.projectId} has no build ${slug}.`);
    }
    this.openPlanners.add(planner);
    return planner;
  }

  async plan(input: BuildSeatRequestInput): Promise<BuildSeatAnswer> {
    const request = BuildSeatRequestSchema.parse(input);
    const planner = await this.openPlanner(request);
    return planner.callSeat(request);
  }

  async freeze(input: BuildFreezeRequest): Promise<BuildFreezeAnswer> {
    const request = BuildFreezeRequestSchema.parse(input);
    const planner = await this.openPlanner(request);
    try {
      return await planner.freeze(request);
    } catch (error) {
      throw toApiError(error);
    }
  }

  async meet(input: BuildMeetingRequestInput): Promise<BuildMeetingAnswer> {
    const request = BuildMeetingRequestSchema.parse(input);
    const planner = await this.openPlanner(request);
    return planner.meet(request);
  }

  async meetingPost(input: BuildMeetingPostRequest): Promise<BuildMeetingAnswer> {
    const request = BuildMeetingPostRequestSchema.parse(input);
    const planner = await this.planner(request.slug);
    if (!planner || planner.record.projectId !== request.projectId) {
      throw new EngineError(
        "not_found",
        `Project ${request.projectId} has no build ${request.slug}.`,
      );
    }
    return planner.post(request);
  }

  /** The plan a build starts from, and the planning record it keeps. */
  private async startingPlan(
    slug: string,
    given: BuildPlan | undefined,
  ): Promise<{ plan: BuildPlan; origin?: BuildOrigin }> {
    const planner = await this.planner(slug);
    if (planner?.busy) {
      throw new EngineError(
        "conflict",
        `Build ${slug} is waiting for a planning seat's answer. Start it when the answer arrives.`,
      );
    }
    const latest = planner ? await planner.latestFrozen() : null;
    if (latest && given && planHash(given) !== latest.frozen.hash) {
      throw new EngineError(
        "validation",
        `Build ${slug}'s plan is frozen at version ${latest.frozen.version}, and this plan differs from it. Freeze the change as a new version with aio-build freeze, then start the build without a plan file.`,
      );
    }
    const plan = latest?.plan ?? given;
    if (!plan) {
      throw new EngineError(
        "validation",
        `Build ${slug} has no frozen plan. Freeze one with aio-build freeze, or start the build with a plan file.`,
      );
    }
    if (!planner) return { plan };
    const { id, createdAt, boxId } = planner.record;
    return { plan, origin: { id, createdAt, boxId } };
  }

  /** Runs `work` after every earlier box check and the work that followed it. */
  private inBoxOrder<T>(work: () => Promise<T>): Promise<T> {
    const next = this.boxChain.then(work);
    this.boxChain = next.catch(() => undefined);
    return next;
  }

  /** Throws `conflict` when another build than `slug` holds box `boxId`. */
  private async requireFreeBox(boxId: string, slug: string): Promise<void> {
    for (const other of await listBuildSlugs(this.deps.projectRoot)) {
      if (other === slug) continue;
      const live = this.controllers.get(other)?.state;
      const state =
        live ?? (await new BuildStore(this.deps.projectRoot, other).loadState().catch(() => null));
      if (!state || state.boxId !== boxId || state.deletedAt) continue;
      if (BOX_BUILD_STATUSES.includes(state.status)) {
        throw new EngineError(
          "conflict",
          `Box ${boxId} already runs the build ${state.slug}, which is ${state.status}. ` +
            "A box runs one build at a time: cancel that build, or use another box.",
        );
      }
    }
  }

  async start(input: BuildCreateInput): Promise<BuildState> {
    const request = BuildCreateSchema.parse(input);
    return this.inBoxOrder(async () => {
      if (request.boxId !== undefined) await this.requireFreeBox(request.boxId, request.slug);
      return this.create(request);
    });
  }

  private async create(request: ReturnType<typeof BuildCreateSchema.parse>): Promise<BuildState> {
    const slug = request.slug;
    if (this.loading.has(slug) || (await this.controller(slug))) {
      throw new EngineError("conflict", `A build named ${slug} already exists.`);
    }
    const creating = (async () => {
      try {
        const { plan, origin } = await this.startingPlan(slug, request.plan);
        const build = await BuildController.create(
          { ...request, plan },
          this.location,
          this.services,
          this.deps.pipeline,
          origin,
        );
        this.controllers.set(slug, build);
        return build;
      } catch (error) {
        throw toApiError(error);
      } finally {
        this.loading.delete(slug);
      }
    })();
    this.loading.set(slug, creating);
    const build = await creating;
    build.start();
    return structuredClone(build.state);
  }

  async get(slug: string): Promise<BuildState | null> {
    const build = await this.controller(slug);
    return build ? structuredClone(build.state) : null;
  }

  async pause(slug: string, reason?: BuildPauseReason): Promise<BuildState> {
    return structuredClone(await (await this.require(slug)).pause(reason));
  }

  async resume(slug: string, reason?: BuildPauseReason): Promise<BuildState> {
    const build = await this.require(slug);
    if (build.state.status !== "cancelled" || build.state.boxId === null) {
      return structuredClone(await build.resume(reason));
    }
    const boxId = build.state.boxId;
    return this.inBoxOrder(async () => {
      await this.requireFreeBox(boxId, slug);
      return structuredClone(await build.resume(reason));
    });
  }

  async cancel(slug: string): Promise<BuildState> {
    return structuredClone(await (await this.require(slug)).cancel());
  }

  async delete(slug: string): Promise<BuildState> {
    return structuredClone(await (await this.require(slug)).delete());
  }

  async resolve(slug: string, input: EscalationResolveInput): Promise<BuildState> {
    const build = await this.require(slug);
    const request = EscalationResolveSchema.parse(input);
    return structuredClone(await build.resolve(request));
  }

  async post(slug: string, input: OwnerPostInput): Promise<OwnerPostAnswer> {
    const post = OwnerPostSchema.parse(input);
    const planner = await this.planner(slug);
    const meeting = planner?.openMeeting;
    if (planner && meeting?.seats.includes(post.to)) {
      const { record } = planner;
      const answer = await planner.post({
        projectId: record.projectId,
        boxId: record.boxId,
        slug,
        meeting: meeting.id,
        body: post.body,
      });
      return { route: "meeting", meeting: answer.meeting };
    }
    const build = await this.controller(slug);
    if (build) return build.post(post);
    if (planner) {
      throw new EngineError(
        "invalid_state",
        `Build ${slug} is in planning, and no meeting under way holds the ${post.to}. In planning, an owner post reaches only the seats of a meeting.`,
      );
    }
    throw new EngineError("not_found", `No build ${slug}.`);
  }

  async messages(slug: string, options: { direct?: boolean } = {}): Promise<Message[]> {
    return (await this.require(slug)).messages(options.direct ?? false);
  }

  async decisions(slug: string): Promise<BuildDecision[]> {
    return (await this.require(slug)).decisions();
  }

  activeCount(): number {
    return (
      [...this.controllers.values()].filter((b) => b.state.status === "running").length +
      [...this.openPlanners].filter((p) => p.busy).length
    );
  }

  async close(): Promise<void> {
    for (const planner of this.openPlanners) planner.stop();
    await Promise.all(
      [...this.controllers.values()].map((b) => b.stopForShutdown(SHUTDOWN_WAIT_MS)),
    );
  }
}

/** Builds the build manager and continues the builds a stopped engine left unfinished. */
export async function createBuildManager(deps: BuildManagerDeps): Promise<EngineBuildManager> {
  const manager = new EngineBuildManager(deps);
  await manager.init();
  return manager;
}
