// A build's working context: its state, plan, files, worktree, seats, and
// the shared agent-call core. Steps receive it and change the build only
// through it, so every change reaches `state.json`, `STATUS.md`, and the
// event stream the same way.
import type {
  BuildSessionSettings,
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
  SeatPlacement,
} from "@aio/contracts";
import { VendorSchema } from "@aio/contracts";
import {
  AgentCalls,
  basicRouting,
  type AgentCallHost,
  type AgentCallSpec,
  type AgentOutcome,
  type CallCache,
  type CallDeps,
  type CallLedger,
} from "../calls/index.js";
import type { AdapterOutput, Clock, CommandRunner, EventDraft, EventSink } from "../core.js";
import type { Logger, PushOptions } from "../api/core-interface.js";
import { UnknownRoleError, type RoleTask } from "./roles/index.js";
import { SeatPlacements, type PlaceOptions } from "./placements/index.js";
import { seatCallSpec } from "./seat-call.js";
import { loadSpecialties, type SpecialtyPack, type SpecialtySources } from "./specialties/index.js";
import type { TeamBus, TeamChannel } from "../team/index.js";
import { SessionDesk } from "./sessions/index.js";
import type { EscalationDraft } from "./escalations.js";
import { renderStatus } from "./status-file.js";
import type { BuildStore } from "./store.js";
import type { BuildWorktree } from "./worktree.js";

export { SEAT_ESTIMATE_TOKENS, agentRoleFor } from "./seat-call.js";

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
  /** The team chat bus. Without it, seat calls run without the bus. */
  team?: TeamBus;
  /** The review runs; without them, the review step fails the build. */
  reviews?: ReviewRuns;
  /** How often the review step reads its run's state, in milliseconds. */
  reviewPollMs?: number;
  /** When a message resumes a session and when it gets a fresh agent. Default: the schema's defaults. */
  sessions?: BuildSessionSettings;
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
  /**
   * The plan tasks the agent works for, which messages to the seat name.
   * Default: the task's own ID.
   */
  taskIds?: readonly string[];
}

/** One turn of an agent in a seat, with a prompt the caller wrote. */
export interface TurnCall {
  seat: RoleName;
  /** The task whose member token the agent gets on the team chat. */
  taskId: string | null;
  key: string;
  step: BuildStep;
  task: RoleTask;
  prompt: string;
  placement: SeatPlacement;
  specialties: readonly SpecialtyPack[];
  output: AdapterOutput;
  /** The session to resume; absent, the turn starts a fresh agent. */
  sessionId?: string;
}

/** The build's call cache: each finished call in `calls/KEY.json`. */
export class FileCallCache implements CallCache {
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
  /** The build's team chat, or `null` when the engine runs no bus. */
  readonly team: TeamChannel | null;
  /** The session registry, and the message turns it gives each seat. */
  readonly sessions: SessionDesk;
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
    this.team =
      services.team?.channel({
        buildId: state.id,
        dir: store.path("messages"),
        tasks: () => this.plan.tasks,
        emit: (draft) => this.emit(draft),
        clock: services.clock,
      }) ?? null;
    this.sessions = new SessionDesk(this);
    this.team?.onMessage((message) => this.sessions.receive(message));
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
        ...(this.plan.usageEstimate ? { usageEstimate: this.plan.usageEstimate } : {}),
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
   * it already made. The agent's session goes into the session registry,
   * and the seat takes no message turn while the call runs.
   */
  callSeat(input: SeatCall): Promise<AgentOutcome<Record<string, unknown>>> {
    const role = this.role(input.seat);
    const packs = input.specialties ?? [];
    const taskIds = input.taskIds ?? [input.task.id];
    return this.sessions.run(
      input.seat,
      async () => {
        const placement = this.seats.place(input.seat, input.placement);
        const outcome = await this.runTurn(
          seatCallSpec(role, placement, {
            seat: input.seat,
            key: input.key,
            step: input.step,
            task: input.task,
            repoPath: this.worktree.path,
            scratchDir: this.store.scratchDir,
            specialties: packs,
          }),
          input.seat,
          input.task.id,
        );
        await this.sessions.started({
          seat: input.seat,
          taskIds,
          task: input.task,
          specialties: packs.map((p) => p.name),
          step: input.step,
          key: input.key,
          placement,
          outcome,
        });
        return outcome;
      },
      taskIds,
    );
  }

  /**
   * Runs one turn of an agent in a seat with a prompt the caller wrote, and
   * returns its answer. Callers that share a seat queue through
   * `sessions.run()`.
   */
  callTurn(input: TurnCall): Promise<AgentOutcome<Record<string, unknown>>> {
    const spec = seatCallSpec(this.role(input.seat), input.placement, {
      seat: input.seat,
      key: input.key,
      step: input.step,
      task: input.task,
      repoPath: this.worktree.path,
      scratchDir: this.store.scratchDir,
      specialties: input.specialties,
      prompt: input.prompt,
      output: input.output,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    });
    return this.runTurn(spec, input.seat, input.taskId);
  }

  /** Makes a seat's call; the agent reaches the team chat with a token of its own, which ends with the call. */
  private async runTurn(
    spec: AgentCallSpec,
    seat: RoleName,
    taskId: string | null,
  ): Promise<AgentOutcome<Record<string, unknown>>> {
    const pass = this.team?.admit({ seat, taskId });
    if (pass) spec.request.team = pass.attachment;
    try {
      return await this.calls.call<Record<string, unknown>>(spec);
    } finally {
      pass?.revoke();
    }
  }
}
