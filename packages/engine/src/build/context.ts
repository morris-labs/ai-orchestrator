// A build's working context: its state, plan, files, worktree, seats, and
// the shared agent-call core. Steps receive it and change the build only
// through it, so every change reaches `state.json`, `STATUS.md`, and the
// event stream the same way.
import type {
  AgentRole,
  EngineRunCreate,
  BuildPlan,
  BuildState,
  BuildStatus,
  BuildStep,
  BuildTaskProgress,
  BuildTaskStatus,
  Escalation,
  RoleDefinition,
  RoleName,
  RunState,
} from "@aio/contracts";
import { VendorSchema } from "@aio/contracts";
import { z } from "zod";
import {
  AgentCalls,
  basicRouting,
  type AgentCallHost,
  type AgentOutcome,
  type CallCache,
  type CallDeps,
  type CallLedger,
} from "../calls/index.js";
import type { Clock, CommandRunner, EventDraft, EventSink } from "../core.js";
import type { Logger, PushOptions } from "../api/core-interface.js";
import { UnknownRoleError, roleAnswerSchema, rolePrompt, type RoleTask } from "./roles/index.js";
import { SeatPlacements, placeCall, type PlaceOptions } from "./placements/index.js";
import {
  loadSpecialties,
  specialtyCall,
  type SpecialtyPack,
  type SpecialtySources,
} from "./specialties/index.js";
import type { EscalationDraft } from "./escalations.js";
import { renderStatus } from "./status-file.js";
import type { BuildStore } from "./store.js";
import type { BuildWorktree } from "./worktree.js";

/** The lease estimate of one seat's turn, in tokens. */
export const SEAT_ESTIMATE_TOKENS = 100_000;

/** A role's answer: a JSON object, which the step that asked reads. */
const RoleAnswerSchema = z.record(z.unknown());

/**
 * The review role that a seat's leases and events name, until they name the
 * seat itself (ADR 0007): a seat that writes files is a `fixer`, and a
 * read-only seat a `reviewer`.
 */
export function agentRoleFor(role: RoleDefinition): AgentRole {
  return role.permission.access === "write" ? "fixer" : "reviewer";
}

/**
 * The engine's review runs, which the review step starts and reads, and
 * which the release ready step pushes.
 */
export interface ReviewRuns {
  start(request: EngineRunCreate): Promise<RunState>;
  get(runId: string): Promise<RunState | null>;
  /** Starts a finished run's post-push loop. */
  push(runId: string, options: PushOptions): Promise<RunState>;
}

/** The engine services a build uses. */
export interface BuildServices {
  call: CallDeps;
  events: EventSink;
  /** Runs `git`. */
  runner: CommandRunner;
  /** Runs the plan's command lines through a shell. */
  shell: CommandRunner;
  clock: Clock;
  log: Logger;
  /** The account skills folders that hold specialties, read on every use. */
  skillDirs: () => string[];
  /** The policy's model per tier and vendor. */
  tierModels?: Parameters<typeof basicRouting>[0]["tierModels"];
  /** The review runs; without them, the review step fails the build. */
  reviews?: ReviewRuns;
  /** How often the review step reads its run's state, in milliseconds. */
  reviewPollMs?: number;
}

/** What a step asks a seat to do. */
export interface SeatCall {
  seat: RoleName;
  /** Unique in the build; a finished call with this key is never made again. */
  key: string;
  step: BuildStep;
  task: RoleTask;
  /** The task's specialty packs, from `specialties()`. */
  specialties?: readonly SpecialtyPack[];
  placement?: PlaceOptions;
}

class FileCallCache implements CallCache {
  constructor(private readonly store: BuildStore) {}

  async read<T>(key: string): Promise<AgentOutcome<T> | null> {
    return (await this.store.readJson<AgentOutcome<T>>(this.store.callPath(key))) ?? null;
  }

  write<T>(key: string, outcome: AgentOutcome<T>): Promise<void> {
    return this.store.writeJson(this.store.callPath(key), outcome);
  }
}

export class BuildContext {
  readonly calls: AgentCalls;
  readonly seats: SeatPlacements;
  /** Aborts the gate's commands when the engine stops; a new drive gets a new one. */
  private driveAbort = new AbortController();
  private writeChain: Promise<void> = Promise.resolve();
  /** The status and step that the last `build.changed` showed. */
  private announced: string | null = null;

  constructor(
    public state: BuildState,
    readonly plan: BuildPlan,
    private ledger: CallLedger,
    readonly store: BuildStore,
    readonly worktree: BuildWorktree,
    readonly roles: ReadonlyMap<string, RoleDefinition>,
    readonly services: BuildServices,
  ) {
    this.seats = new SeatPlacements(roles, state.placements);
    const host: AgentCallHost = {
      id: state.id,
      owner: { runId: null, buildId: state.id },
      round: () => 1,
      ledger: () => this.ledger,
      persist: () => this.persist(),
      emit: (draft) => this.emit(draft),
      status: {
        paused: () => this.state.status === "paused",
        pausedUntil: () => this.state.pausedUntil,
        pause: async (until) => {
          this.state.status = "paused";
          if (until) this.state.pausedUntil = until;
          else delete this.state.pausedUntil;
          await this.persist();
        },
        resume: async () => {
          this.state.status = "running";
          delete this.state.pausedUntil;
          await this.persist();
        },
      },
      cache: new FileCallCache(store),
      routing: basicRouting({
        fallbackOrder: VendorSchema.options,
        timeoutMs: 60 * 60_000,
        ...(services.call.models ? { models: services.call.models } : {}),
        ...(services.tierModels ? { tierModels: services.tierModels } : {}),
      }),
      treeGuard: { ignore: [store.dir] },
      commits: {
        head: () => worktree.head(),
        resetKeep: (sha) => worktree.git.resetKeep(sha),
      },
    };
    this.calls = new AgentCalls(host, services.call);
  }

  /** Aborts when the engine stops the drive or the build is cancelled. */
  get signal(): AbortSignal {
    return AbortSignal.any([this.driveAbort.signal, this.calls.signal]);
  }

  /** Starts a drive: a fresh abort signal for the gate's commands. */
  beginDrive(): Promise<void> {
    if (this.driveAbort.signal.aborted) this.driveAbort = new AbortController();
    return this.calls.beginDrive();
  }

  /** Stops the gate's commands and every later checkpoint of this drive. */
  stopDrive(): void {
    this.driveAbort.abort();
    this.calls.stopCalls();
  }

  private now(): string {
    return new Date(this.services.clock.now()).toISOString();
  }

  /**
   * Saves the state, the call ledger, and the status file, then sends
   * `build.changed` when the status or the step changed since the last one
   * this context sent. The first save of a context always sends it, so the
   * server knows the build before any of its agent or lease events.
   */
  async persist(): Promise<void> {
    this.state.updatedAt = this.now();
    this.state.placements = this.seats.state();
    const state = structuredClone(this.state);
    const ledger = structuredClone(this.ledger);
    const status = renderStatus(state, this.plan);
    const write = this.writeChain.then(() => this.store.save(state, ledger, status));
    this.writeChain = write.catch((error: unknown) => {
      this.services.log.error("Couldn't save a build's state", {
        build: this.state.slug,
        error: String(error),
      });
    });
    await write;
    const shown = `${state.status}:${state.step}`;
    if (this.announced === shown) return;
    this.announced = shown;
    await this.emit({
      type: "build.changed",
      build: {
        id: state.id,
        slug: state.slug,
        projectId: state.projectId,
        boxId: state.boxId,
        container: state.container,
        status: state.status,
        step: state.step,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
      },
    });
  }

  /** Sets a task's status, saves it, and sends `build.task.changed`. */
  async setTaskStatus(id: string, status: BuildTaskStatus): Promise<void> {
    const task = this.task(id);
    const previous = task.status;
    if (previous === status) return;
    task.status = status;
    await this.persist();
    await this.emit({
      type: "build.task.changed",
      buildId: this.state.id,
      taskId: id,
      status,
      previousStatus: previous,
    });
  }

  /** Sends an event and records it in the build's `events.jsonl`. */
  async emit(draft: EventDraft): Promise<void> {
    const event = this.services.events.emit(draft);
    await this.store.appendEvent(event);
  }

  async setStatus(status: BuildStatus, note?: string): Promise<void> {
    this.state.status = status;
    if (note === undefined) delete this.state.note;
    else this.state.note = note;
    if (status !== "paused") delete this.state.pausedUntil;
    await this.persist();
  }

  async setStep(step: BuildStep): Promise<void> {
    if (this.state.step === step) return;
    this.state.step = step;
    await this.persist();
  }

  /** The progress record of a task in the plan. */
  task(id: string): BuildTaskProgress {
    const task = this.state.tasks.find((t) => t.id === id);
    if (!task) throw new Error(`The build has no task ${id}.`);
    return task;
  }

  /** Writes an escalation file, adds it to the state, and makes the build wait for it. */
  async escalate(draft: EscalationDraft): Promise<Escalation> {
    const id = `E${this.state.escalations.length + 1}`;
    const escalation: Escalation = {
      id,
      kind: draft.kind,
      level: draft.level,
      taskId: draft.taskId,
      summary: draft.summary,
      file: `escalations/${id}.json`,
      createdAt: this.now(),
    };
    await this.store.writeJson(this.store.escalationPath(id), {
      ...escalation,
      build: this.state.slug,
      step: this.state.step,
      details: draft.details,
    });
    this.state.escalations.push(escalation);
    await this.setStatus("waiting_escalation", `Waiting for escalation ${id}: ${draft.summary}`);
    return escalation;
  }

  /** Where the build finds specialties: the repository, then the account skills folders. */
  specialtySources(): SpecialtySources {
    return { repoRoot: this.state.repoPath, skillDirs: this.services.skillDirs() };
  }

  /**
   * Loads the packs of a task's specialties. Throws `UnknownSpecialtyError`
   * when one no longer exists.
   */
  specialties(names: readonly string[]): Promise<SpecialtyPack[]> {
    return loadSpecialties(names, this.specialtySources());
  }

  /** A role definition by seat name. Throws `UnknownRoleError` for a seat no role defines. */
  role(seat: RoleName): RoleDefinition {
    const role = this.roles.get(seat);
    if (!role) throw new UnknownRoleError(seat, [...this.roles.keys()].sort().join(", "));
    return role;
  }

  /**
   * Starts an agent in `seat` for one task, on the seat's placement, and
   * returns its answer. The call cache returns a finished call's answer
   * without calling again, which is how a restarted build skips the calls
   * it already made.
   */
  async callSeat(input: SeatCall): Promise<AgentOutcome<Record<string, unknown>>> {
    const role = this.role(input.seat);
    const placement = this.seats.place(input.seat, input.placement);
    const writes = role.permission.access === "write";
    const packs = input.specialties ?? [];
    const spec = placeCall(
      specialtyCall(
        {
          key: input.key,
          role: agentRoleFor(role),
          method: writes ? "fix" : "review",
          request: {
            prompt: rolePrompt(role, { ...input.task, specialties: packs }),
            repoPath: this.worktree.path,
            toolPolicy: writes ? "write" : "read-only",
            scratchDir: this.store.scratchDir,
            timeoutMs: role.turnTimeoutMinutes * 60_000,
            output: {
              schema: RoleAnswerSchema,
              json: (roleAnswerSchema(role) as Record<string, unknown> | null) ?? {
                type: "object",
              },
            },
          },
          groupId: null,
          estimateTokens: SEAT_ESTIMATE_TOKENS,
          seat: input.seat,
          step: input.step,
        },
        packs,
      ),
      placement,
    );
    return this.calls.call<Record<string, unknown>>(spec);
  }
}
