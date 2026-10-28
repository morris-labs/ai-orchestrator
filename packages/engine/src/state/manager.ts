// The engine API's `RunManager` over the core's `RunController`s: one
// controller per run, loaded from its run directory on demand, with the
// project-wide reads (run list, preview, usage samples) the API needs.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RunIdSchema,
  TimedUsageSampleSchema,
  type DecisionAnswer,
  type EngineRunCreate,
  type FileGroup,
  type Finding,
  type Profile,
  type Role,
  type RoundSummary,
  type RunRequest,
  type RunState,
  type TimedUsageSample,
  type Vendor,
} from "@agentbox/contracts";
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
import { groupFiles } from "../group/group.js";
import { PolicyError, loadPolicy } from "../policy/load.js";
import { GhCliClient } from "../postpush/github.js";
import { parseDiff } from "../range/diff.js";
import { ExecaRunner } from "../range/exec.js";
import { Git, GitError } from "../range/git.js";
import { RangeError, resolveRange } from "../range/resolve.js";
import { RunNotFoundError, RunStore, listRunIds } from "../run/store.js";
import { RunController } from "./controller.js";

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

async function readWorkingFile(repoPath: string, path: string): Promise<string | null> {
  try {
    return await readFile(join(repoPath, path), "utf8");
  } catch {
    return null;
  }
}

function inWindow(time: string, filter: UsageFilter): boolean {
  const t = Date.parse(time);
  if (filter.since !== undefined && t < Date.parse(filter.since)) return false;
  if (filter.until !== undefined && t > Date.parse(filter.until)) return false;
  return true;
}

export class EngineRunManager implements RunManager {
  private readonly controllers = new Map<string, RunController>();
  private readonly loading = new Map<string, Promise<RunController | null>>();
  private readonly engineDeps: EngineDeps;

  constructor(private readonly deps: CoreDeps) {
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

  /**
   * Loads every run that is still active, so `activeRunCount()` counts it,
   * and continues the ones a stopped engine left pending or running.
   */
  async init(): Promise<void> {
    for (const id of await listRunIds(this.deps.projectRoot)) {
      const state = await this.readState(id);
      if (!state || !ACTIVE_RUN_STATUSES.includes(state.status)) continue;
      const run = await this.controller(id);
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
      }
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

  preview(request: RunRequest): Promise<RunPreview> {
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
          readOnly: request.readOnly,
          includeWorktree: true,
          prNumber: request.prNumber,
        },
        github,
      );
      const withWorktree = request.includeWorktree && range.includeWorktree;
      const git = new Git(runner, request.repoPath);
      const tip = withWorktree ? null : range.tipSha;
      const files = parseDiff(await git.diff(range.diffBaseSha, tip));
      const groups = await groupFiles(files, {
        policy: await loadPolicy(this.location.projectRoot, this.location.policyPath),
        readFile: (path) =>
          tip === null ? readWorkingFile(request.repoPath, path) : git.show(tip, path),
      });
      return {
        baseSha: range.baseSha,
        tipSha: range.tipSha,
        diffBaseSha: range.diffBaseSha,
        groups,
        changedLines: groups.reduce((n, g) => n + g.changedLines, 0),
        dirty: range.dirty,
      };
    });
  }

  start(request: EngineRunCreate): Promise<RunState> {
    return api(async () => {
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
    return (await this.controller(runId))?.state ?? null;
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
    const store = new RunStore(this.deps.projectRoot, runId);
    const diffBase = (await store.loadEngineState()).diffBaseSha ?? state.baseSha;
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
      file && diffBase && state.tipSha
        ? await quiet(() => git.diffForPrompt(diffBase, state.tipSha ?? null, [file]))
        : null;
    const fixCommit = finding.fixCommit;
    const fixDiff = fixCommit
      ? await quiet(() =>
          git.run(["show", "--no-color", "--format=", fixCommit, ...(file ? ["--", file] : [])]),
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
        events = await new RunStore(this.deps.projectRoot, id).loadEvents();
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

  activeRunCount(): number {
    let n = 0;
    for (const run of this.controllers.values()) {
      if (ACTIVE_RUN_STATUSES.includes(run.status)) n += 1;
    }
    return n;
  }

  /**
   * Leaves every run where it is. A run in progress stays `running` in its
   * run directory, and the next engine continues it from its stage.
   */
  async close(): Promise<void> {
    await Promise.resolve();
  }
}

/** Builds the run manager and continues the runs a stopped engine left unfinished. */
export async function createRunManager(deps: CoreDeps): Promise<EngineRunManager> {
  const manager = new EngineRunManager(deps);
  await manager.init();
  return manager;
}
