// The engine API's `RunManager` over the core's `RunController`s: one
// controller per run, loaded from its run directory on demand, with the
// project-wide reads (run list, preview, usage samples) the API needs.
import {
  RunIdSchema,
  assertReviewModelAllowed,
  TimedUsageSampleSchema,
  type DecisionAnswer,
  type EngineRunCreate,
  type FileGroup,
  type Finding,
  type Profile,
  type Role,
  type RoundSummary,
  type EngineRunPreview,
  type RunRetry,
  type RunState,
  type TimedUsageSample,
  type Vendor,
  estimateRunTokens,
  runDepth,
} from "@aio/contracts";
import {
  ACTIVE_RUN_STATUSES,
  EngineError,
  type CoreDeps,
  type FindingDetail,
  type FindingFilter,
  type RunListFilter,
  type RunManager,
  type RunPreview,
  type UsageFilter,
} from "../api/core-interface.js";
import type { EngineDeps } from "../core.js";
import { globProblem } from "../policy/glob.js";
import { PolicyError, loadPolicy, loadPolicyExtras } from "../policy/load.js";
import { GhCliClient } from "../postpush/github.js";
import { ExecaRunner } from "../range/exec.js";
import { Git, GitError } from "../range/git.js";
import { RangeError, resolveRange } from "../range/resolve.js";
import { resolveReviewRange } from "../range/review-range.js";
import { NewerRunStateError } from "../run/state-version.js";
import { RunNotFoundError, RunStore, listRunIds } from "../run/store.js";
import { loadTokenHistory } from "../run/token-history.js";
import { RunController, startingRoles } from "./controller.js";
import { assignRoles } from "./profiles.js";
import { chooseDisprover } from "../verify/verify.js";
import { chooseConfirmer, chooseSweeper } from "./steps.js";

/**
 * Turns a core error into one the API maps to a status: a dirty tree keeps
 * `dirty_tree`, other range, policy, and git problems become `validation`,
 * and a missing run becomes `run_not_found`. Errors that already carry an
 * API code, such as `InvalidStateError`, pass through.
 */
export function toApiError(error: unknown): unknown {
  if (error instanceof RangeError) {
    return error.code === "dirty_tree" ? error : new EngineError("validation", error.message);
  }
  if (error instanceof PolicyError || error instanceof GitError) {
    return new EngineError("validation", error.message);
  }
  if (error instanceof RunNotFoundError) {
    return new EngineError("run_not_found", `No run ${error.runId}.`);
  }
  return error;
}

async function api<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toApiError(error);
  }
}

function inWindow(time: string, filter: UsageFilter): boolean {
  const t = Date.parse(time);
  if (filter.since !== undefined && t < Date.parse(filter.since)) return false;
  if (filter.until !== undefined && t > Date.parse(filter.until)) return false;
  return true;
}

/** The most excluded files a preview lists; its count covers them all. */
const PREVIEW_EXCLUDED_LIMIT = 1000;

/** Refuses a run's exclusion glob that can't compile, before anything starts. */
function refuseBadExcludes(globs: readonly string[] | undefined): void {
  const problem = (globs ?? []).map(globProblem).find((p) => p !== null);
  if (problem) throw new EngineError("validation", problem);
}

/** How long `close()` waits for a run driver to stop. */
const SHUTDOWN_WAIT_MS = 5000;

export class EngineRunManager implements RunManager {
  private readonly controllers = new Map<string, RunController>();
  /** Runs whose torn `events.jsonl` is already logged, so each is logged once. */
  private readonly tornEventLogs = new Set<string>();
  private readonly loading = new Map<string, Promise<RunController | null>>();
  private readonly engineDeps: EngineDeps;

  constructor(private readonly deps: CoreDeps) {
    for (const [vendor, model] of Object.entries(deps.models ?? {}) as [Vendor, string][]) {
      assertReviewModelAllowed(vendor, model);
    }
    const runner = deps.runner ?? new ExecaRunner();
    this.engineDeps = {
      adapters: deps.adapters,
      broker: deps.leases,
      events: deps.events,
      runner,
      github: deps.github ?? new GhCliClient(runner),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.models ? { models: deps.models } : {}),
      container: deps.container,
      log: deps.log,
    };
  }

  private get location() {
    return {
      projectRoot: this.deps.projectRoot,
      ...(this.deps.policyPath ? { policyPath: this.deps.policyPath } : {}),
    };
  }

  /** Timers that resume runs paused for a usage limit, by run id. */
  private readonly resumeTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Loads every run that is still active, so `activeRunCount()` counts it,
   * continues the ones a stopped engine left pending or running, and sets a
   * timer for the ones paused until a usage limit resets. A run that can't
   * be loaded is marked failed and skipped, so one bad run directory never
   * keeps the engine from starting.
   */
  async init(): Promise<void> {
    for (const id of await listRunIds(this.deps.projectRoot)) {
      const state = await this.readState(id);
      if (!state || !ACTIVE_RUN_STATUSES.includes(state.status)) continue;
      let run: RunController | null;
      try {
        run = await this.controller(id);
      } catch (error) {
        if (error instanceof NewerRunStateError) continue;
        await this.markFailed(state, error);
        continue;
      }
      if (!run) continue;
      if (state.status === "running" || state.status === "pending") {
        this.deps.log.info("Continuing a run the engine left unfinished", {
          runId: id,
          stage: state.stage,
        });
        try {
          await run.start();
        } catch (error) {
          this.deps.log.warn("Couldn't continue a run", { runId: id, error: String(error) });
        }
      } else if (state.status === "paused" && state.pausedUntil) {
        this.scheduleResume(run, state.pausedUntil);
      }
    }
  }

  /** Resumes a run paused for a usage limit once the limit resets. */
  private scheduleResume(run: RunController, until: string): void {
    const now = this.deps.clock?.now() ?? Date.now();
    const ms = Math.max(0, Date.parse(until) - now);
    this.deps.log.info("A run waits for a usage limit to reset", { runId: run.id, until });
    const timer = setTimeout(() => {
      this.resumeTimers.delete(run.id);
      if (run.status !== "paused" || run.running) return;
      try {
        void run.start();
      } catch (error) {
        this.deps.log.warn("Couldn't resume a run after its limit reset", {
          runId: run.id,
          error: String(error),
        });
      }
    }, ms);
    timer.unref();
    this.resumeTimers.set(run.id, timer);
  }

  /** Records that a run's files can't be loaded. Never rejects. */
  private async markFailed(state: RunState, error: unknown): Promise<void> {
    const message = `The engine couldn't load the run: ${String((error as Error)?.message ?? error)}`;
    this.deps.log.error("Marked a run failed because it can't be loaded", {
      runId: state.id,
      error: String(error),
    });
    try {
      const now = new Date(this.deps.clock?.now() ?? Date.now()).toISOString();
      await new RunStore(this.deps.projectRoot, state.id).saveState({
        ...state,
        status: "failed",
        stopReason: "error",
        error: message,
        updatedAt: now,
        finishedAt: now,
      });
    } catch (writeError) {
      this.deps.log.error("Couldn't record the failed run", {
        runId: state.id,
        error: String(writeError),
      });
    }
  }

  /** The controller for `runId`, loaded from disk once; `null` for an unknown run. */
  private controller(runId: string): Promise<RunController | null> {
    const live = this.controllers.get(runId);
    if (live) return Promise.resolve(live);
    if (!RunIdSchema.safeParse(runId).success) return Promise.resolve(null);
    let pending = this.loading.get(runId);
    if (!pending) {
      pending = (async () => {
        try {
          const run = await RunController.load(runId, this.location, this.engineDeps);
          this.controllers.set(runId, run);
          return run;
        } catch (error) {
          if (error instanceof RunNotFoundError) return null;
          throw toApiError(error);
        } finally {
          this.loading.delete(runId);
        }
      })();
      this.loading.set(runId, pending);
    }
    return pending;
  }

  private async require(runId: string): Promise<RunController> {
    const run = await this.controller(runId);
    if (!run) throw new EngineError("run_not_found", `No run ${runId}.`);
    return run;
  }

  /** The state of a run from its controller or its `state.json`; `null` when unreadable. */
  private async readState(runId: string): Promise<RunState | null> {
    const live = this.controllers.get(runId);
    if (live) return live.state;
    try {
      return await new RunStore(this.deps.projectRoot, runId).loadState();
    } catch (error) {
      if (error instanceof NewerRunStateError && error.stoppedState) return error.stoppedState;
      if (!(error instanceof RunNotFoundError)) {
        this.deps.log.warn("Skipped a run whose state.json can't be read", {
          runId,
          error: String(error),
        });
      }
      return null;
    }
  }

  /** Runs, newest first. */
  async list(filter: RunListFilter): Promise<RunState[]> {
    const ids = (await listRunIds(this.deps.projectRoot)).reverse();
    const out: RunState[] = [];
    for (const id of ids) {
      const state = await this.readState(id);
      if (!state) continue;
      if (filter.projectId !== undefined && state.projectId !== filter.projectId) continue;
      if (filter.boxId !== undefined && state.boxId !== filter.boxId) continue;
      if (filter.status !== undefined && state.status !== filter.status) continue;
      out.push(state);
    }
    return out;
  }

  preview(request: EngineRunPreview): Promise<RunPreview> {
    return api(async () => {
      const { runner, github } = this.engineDeps;
      // Resolve as if the working tree were included, so a dirty tree is
      // reported in `dirty` instead of refused.
      const range = await resolveRange(
        runner,
        {
          repoPath: request.repoPath,
          base: request.base,
          tip: request.tip,
          mergeBase: request.mergeBase,
          exactBase: request.exactBase,
          scope: request.scope,
          readOnly: request.readOnly,
          includeWorktree: true,
          prNumber: request.prNumber,
        },
        github,
      );
      const policy = await loadPolicy(this.location.projectRoot, this.location.policyPath);
      refuseBadExcludes(request.excludePaths);
      const extras = await loadPolicyExtras(this.location.projectRoot, this.location.policyPath);
      const { groups, excluded } = await resolveReviewRange({
        git: new Git(runner, request.repoPath),
        resolved: { ...range, includeWorktree: request.includeWorktree && range.includeWorktree },
        request: { ...request, modelTier: request.modelTier ?? "auto" },
        policy,
        groupSizeLimit: extras.groupSizeLimit ?? undefined,
      });
      const depth = runDepth(request);
      const whole = request.scope === "whole";
      const changedLines = groups.reduce((n, g) => n + g.changedLines, 0);
      const available = (["claude", "codex", "copilot"] as const).filter(
        (v) => this.deps.adapters[v],
      );
      // A preview request can leave the profile and the cross-vendor rule out.
      const profile = request.profile ?? "offload";
      const crossVendor = request.crossVendor ?? true;
      const roles = assignRoles({
        profile,
        round: 1,
        available,
        manual: startingRoles(request.roles, available),
        crossVendor,
      });
      const verifiers = Object.fromEntries(
        roles.reviewer.map((v) => [
          v,
          chooseDisprover(v, roles, { crossVendor, available, profile }),
        ]),
      );
      return {
        vendors: Object.keys(this.deps.adapters) as Vendor[],
        baseSha: range.baseSha,
        tipSha: range.tipSha,
        diffBaseSha: range.diffBaseSha,
        groups,
        changedLines,
        dirty: range.dirty,
        tokenEstimate: estimateRunTokens({
          depth,
          scope: whole ? "whole" : "range",
          effort: request.reviewerEffort,
          readOnly: request.readOnly,
          reviewers: roles.reviewer,
          verifiers,
          fixer: roles.fixer,
          // Without the cross-vendor rule, the fixer confirms its own fixes.
          confirmer: crossVendor
            ? (chooseConfirmer(roles.confirmer, [roles.fixer], available) ?? roles.confirmer)
            : roles.fixer,
          sweeper: chooseSweeper(roles.reviewer),
          groups,
          history: await loadTokenHistory(this.location.projectRoot),
          hostHistory: request.hostTokenSamples ?? [],
        }),
        excluded: {
          count: excluded.length,
          files: excluded.slice(0, PREVIEW_EXCLUDED_LIMIT),
        },
      };
    });
  }

  start(request: EngineRunCreate): Promise<RunState> {
    return api(async () => {
      refuseBadExcludes(request.excludePaths);
      const exists =
        this.controllers.has(request.runId) ||
        (await listRunIds(this.deps.projectRoot)).includes(request.runId);
      if (exists) throw new EngineError("conflict", `Run ${request.runId} already exists.`);
      const run = await RunController.create(request, this.location, this.engineDeps);
      this.controllers.set(run.id, run);
      this.deps.log.info("Started a run", { runId: run.id, repoPath: request.repoPath });
      return run.start();
    });
  }

  async get(runId: string): Promise<RunState | null> {
    try {
      return (await this.controller(runId))?.state ?? null;
    } catch (error) {
      if (error instanceof NewerRunStateError && error.stoppedState) return error.stoppedState;
      throw error;
    }
  }

  async pause(runId: string): Promise<RunState> {
    return (await this.require(runId)).pause();
  }

  async resume(runId: string): Promise<RunState> {
    return (await this.require(runId)).resume();
  }

  async cancel(runId: string): Promise<RunState> {
    return (await this.require(runId)).cancel();
  }

  async profile(runId: string, profile: Profile): Promise<RunState> {
    return (await this.require(runId)).setProfile(profile);
  }

  async assign(runId: string, role: Role, vendors: Vendor[]): Promise<RunState> {
    return (await this.require(runId)).assign(role, vendors);
  }

  async rebaseBase(runId: string): Promise<RunState> {
    return (await this.require(runId)).rebaseBase();
  }

  retry(runId: string, options: RunRetry): Promise<RunState> {
    return api(async () => (await this.require(runId)).retry(options));
  }

  async decide(runId: string, answer: DecisionAnswer): Promise<RunState> {
    return (await this.require(runId)).decide(answer);
  }

  async push(runId: string, options: { title?: string; draft: boolean }): Promise<RunState> {
    return (await this.require(runId)).push(options);
  }

  async groups(runId: string): Promise<FileGroup[]> {
    return (await this.require(runId)).groups();
  }

  async rounds(runId: string): Promise<RoundSummary[]> {
    return (await this.require(runId)).rounds();
  }

  async findings(runId: string, filter: FindingFilter): Promise<Finding[]> {
    return (await this.require(runId)).findings.filter(
      (f) =>
        (filter.verdict === undefined || f.verdict === filter.verdict) &&
        (filter.severity === undefined || f.severity === filter.severity) &&
        (filter.round === undefined || f.round === filter.round),
    );
  }

  /**
   * A finding with the diff of its file over the run's range and, once
   * fixed, the fix commit's diff of that file.
   */
  async finding(runId: string, findingId: string): Promise<FindingDetail | null> {
    const run = await this.controller(runId);
    const finding = run?.findings.find((f) => f.id === findingId);
    if (!run || !finding) return null;
    const state = run.state;
    const git = new Git(this.engineDeps.runner, state.request.repoPath);
    const range = await run.reviewRange().catch(() => null);
    const quiet = async (work: () => Promise<string>) => {
      try {
        const text = await work();
        return text.trim() === "" ? null : text;
      } catch {
        return null;
      }
    };
    const file = finding.file;
    const diff =
      file && range?.branchDiffBase
        ? await quiet(() => git.diffForPrompt(range.branchDiffBase, range.tipCommit, [file]))
        : null;
    const fixCommit = finding.fixCommit;
    const fixDiff = fixCommit
      ? await quiet(() =>
          // The path is reviewer output, so it is a literal path, not a pathspec.
          git.run([
            "--literal-pathspecs",
            "show",
            "--no-color",
            "--format=",
            fixCommit,
            ...(file ? ["--", file] : []),
          ]),
        )
      : null;
    return { finding, diff, fixDiff };
  }

  async waive(runId: string, findingId: string, reason: string): Promise<Finding> {
    const run = await this.require(runId);
    if (!run.findings.some((f) => f.id === findingId)) {
      throw new EngineError("not_found", `Run ${runId} has no finding ${findingId}.`);
    }
    return run.waive(findingId, reason);
  }

  /** Every `usage.sample` the project's runs recorded, oldest first. */
  async usageSamples(filter: UsageFilter): Promise<TimedUsageSample[]> {
    const out: TimedUsageSample[] = [];
    for (const id of await listRunIds(this.deps.projectRoot)) {
      let events;
      try {
        events = await new RunStore(this.deps.projectRoot, id).loadEvents((skipped) => {
          if (this.tornEventLogs.has(id)) return;
          this.tornEventLogs.add(id);
          this.deps.log.warn("Skipped lines of a run's events.jsonl that aren't JSON", {
            runId: id,
            skipped,
          });
        });
      } catch (error) {
        this.deps.log.warn("Skipped a run whose events.jsonl can't be read", {
          runId: id,
          error: String(error),
        });
        continue;
      }
      for (const event of events) {
        if (event.type !== "usage.sample") continue;
        if (filter.vendor !== undefined && event.vendor !== filter.vendor) continue;
        if (!inWindow(event.time, filter)) continue;
        const parsed = TimedUsageSampleSchema.safeParse(event);
        if (parsed.success) out.push(parsed.data);
      }
    }
    return out.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  }

  /**
   * Runs that keep the container alive. A run paused until a usage limit
   * resets doesn't count: the next engine resumes it from its run directory.
   */
  activeRunCount(): number {
    let n = 0;
    for (const run of this.controllers.values()) {
      if (!ACTIVE_RUN_STATUSES.includes(run.status)) continue;
      if (run.status === "paused" && run.state.pausedUntil) continue;
      n += 1;
    }
    return n;
  }

  /**
   * Leaves every run where it is. A run in progress stays `running` in its
   * run directory, and the next engine continues it from its stage.
   *
   * Marks the runs as stopping before its first `await`, so the caller can
   * close the lease broker right after calling this without failing the
   * runs that wait for a lease. Resolves when their drivers have stopped,
   * or after a few seconds for a driver still inside an agent call.
   */
  async close(): Promise<void> {
    for (const timer of this.resumeTimers.values()) clearTimeout(timer);
    this.resumeTimers.clear();
    const stopping = [...this.controllers.values()].map((run) =>
      run.stopForShutdown(SHUTDOWN_WAIT_MS),
    );
    await Promise.all(stopping);
  }
}

/** Builds the run manager and continues the runs a stopped engine left unfinished. */
export async function createRunManager(deps: CoreDeps): Promise<EngineRunManager> {
  const manager = new EngineRunManager(deps);
  await manager.init();
  return manager;
}
