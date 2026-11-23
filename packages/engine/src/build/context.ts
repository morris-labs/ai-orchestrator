// A build's working context: its state, plan, files, worktree, seats, and
// the shared agent-call core. Steps receive it and change the build only
// through it, so every change reaches `state.json`, `STATUS.md`, and the
// event stream the same way.
import type {
  BuildDecision,
  BuildSessionSettings,
  DecisionAnswer,
  EngineRunCreate,
  RunRetry,
  BuildPlan,
  BuildState,
  BuildStatus,
  BuildStep,
  BuildTaskProgress,
  BuildTaskStatus,
  Escalation,
  Message,
  OwnerPost,
  OwnerPostAnswer,
  RoleDefinition,
  RoleName,
  RunState,
  SeatPlacement,
} from "@aio/contracts";
import { VendorSchema, dependentsOf } from "@aio/contracts";
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
import { DecisionLog, checkDirectMessage, decisionsFor, decisionsText } from "./owner/index.js";
import type { EscalationDraft } from "./escalations.js";
import { PmInboxFile, type PmItemDraft } from "./inbox.js";
import { capQuestion } from "./questions.js";
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
  /** Answers the decision a run waits for. */
  decide(runId: string, answer: DecisionAnswer): Promise<RunState>;
  /** Continues a failed run. */
  retry(runId: string, options: RunRetry): Promise<RunState>;
  /** Pauses, resumes, and cancels the run with the build. */
  pause(runId: string): Promise<RunState>;
  resume(runId: string): Promise<RunState>;
  cancel(runId: string): Promise<RunState>;
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
  /**
   * The secret names the project gives the build, from the secrets broker.
   * Without it, preflight doesn't check the plan's secrets.
   */
  secretNames?: () => Promise<string[]>;
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
  private agentCalls: AgentCalls;
  private readonly host: AgentCallHost;
  readonly seats: SeatPlacements;
  /** The build's team chat, or `null` when the engine runs no bus. */
  readonly team: TeamChannel | null;
  /** The session registry, and the message turns it gives each seat. */
  readonly sessions: SessionDesk;
  /** The owner's decisions: one for each owner post. */
  readonly decisions: DecisionLog;
  /** The Project manager's inbox: a pointer for each escalation and each digest. */
  readonly inbox: PmInboxFile;
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
          delete this.state.pausedBy;
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
    this.host = host;
    this.agentCalls = new AgentCalls(host, services.call);
    this.team =
      services.team?.channel({
        buildId: state.id,
        dir: store.path("messages"),
        tasks: () => this.plan.tasks,
        emit: (draft) => this.emit(draft),
        check: async (message) => {
          const earlier = () => this.team!.list();
          await checkDirectMessage(message, this.plan, earlier);
          return capQuestion(message, this.plan, earlier, (draft) => this.escalate(draft));
        },
        clock: services.clock,
      }) ?? null;
    this.decisions = new DecisionLog(store.path("decisions"), state.id);
    this.inbox = new PmInboxFile(
      store.path("inbox.json"),
      (file) => store.path(file),
      () => this.now(),
    );
    this.sessions = new SessionDesk(this);
    // The decision comes first: the log's queue then holds it before any
    // turn for the post reads it.
    this.team?.onMessage((message) => {
      if (message.from.kind === "owner") void this.decisions.record(message).catch(() => undefined);
    });
    this.team?.onMessage((message) => this.sessions.receive(message));
  }

  /** The agent-call core: leases, the call cache, and the pause and cancel controls. */
  get calls(): AgentCalls {
    return this.agentCalls;
  }

  /**
   * Replaces the agent-call core after a cancel, whose core refuses every
   * later call, so the closing record and a resumed build can call agents.
   */
  renewCalls(): void {
    this.agentCalls = new AgentCalls(this.host, this.services.call);
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
    await this.emit(this.taskChanged(id, status, previous));
  }

  /** The `build.task.changed` event for a task, with the plan milestone it belongs to. */
  private taskChanged(id: string, status: BuildTaskStatus, previous: BuildTaskStatus): EventDraft {
    const milestone = this.plan.milestones.find((m) => m.tasks.includes(id))?.id;
    return {
      type: "build.task.changed",
      buildId: this.state.id,
      taskId: id,
      status,
      previousStatus: previous,
      ...(milestone ? { milestone } : {}),
    };
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
    if (status !== "paused") {
      delete this.state.pausedUntil;
      delete this.state.pausedBy;
    }
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

  /**
   * Writes an escalation file and adds it to the state. An escalation with a
   * task pauses that task and every task that depends on it, and the other
   * tasks go on. One without a task makes the build wait for it.
   */
  async escalate(draft: EscalationDraft): Promise<Escalation> {
    const id = `E${this.state.escalations.length + 1}`;
    // An escalation about a task that is done, such as a question about it
    // that came after, pauses nothing.
    const { taskId } = draft;
    const pauses = taskId !== null && this.task(taskId).status !== "done";
    const tasks =
      taskId !== null && pauses
        ? [
            taskId,
            ...dependentsOf(this.plan.tasks, taskId).filter((t) => this.task(t).status !== "done"),
          ]
        : [];
    const escalation: Escalation = {
      id,
      kind: draft.kind,
      level: draft.level,
      taskId: draft.taskId,
      tasks,
      ...(draft.runId ? { runId: draft.runId } : {}),
      summary: draft.summary,
      file: `escalations/${id}.json`,
      status: "open",
      createdAt: this.now(),
    };
    await this.store.writeJson(this.store.escalationPath(id), {
      ...escalation,
      build: this.state.slug,
      step: this.state.step,
      details: draft.details,
    });
    this.state.escalations.push(escalation);
    await this.toProjectManager({
      kind: "escalation",
      ref: id,
      summary: `Escalation ${id} (${draft.kind}, for the ${draft.level.replace("_", " ")}): ${draft.summary}`,
      file: escalation.file,
      needsAnswer: true,
    });
    if (!draft.taskId) {
      await this.waitForEscalations();
      return escalation;
    }
    if (!pauses) {
      await this.persist();
      return escalation;
    }
    await this.setTaskStatus(draft.taskId, "failed");
    for (const t of tasks.slice(1)) await this.setTaskStatus(t, "blocked");
    return escalation;
  }

  /** The escalations that wait for a decision. */
  openEscalations(): Escalation[] {
    return this.state.escalations.filter((e) => e.status === "open");
  }

  /** Makes the build wait for its open escalations, with a note that names them. */
  async waitForEscalations(): Promise<void> {
    const open = this.openEscalations();
    const [only] = open;
    const note =
      open.length === 1 && only
        ? `Waiting for escalation ${only.id}: ${only.summary}`
        : `Waiting for escalations ${open.map((e) => e.id).join(", ")}.`;
    await this.setStatus("waiting_escalation", note);
  }

  /**
   * Saves a changed escalation in the state and in its file, which keeps
   * the details the step wrote.
   */
  async saveEscalation(escalation: Escalation): Promise<void> {
    const path = this.store.escalationPath(escalation.id);
    const saved = (await this.store.readJson<Record<string, unknown>>(path)) ?? {};
    await this.store.writeJson(path, { ...saved, ...escalation });
    await this.persist();
    if (escalation.status === "resolved") await this.inbox.answered("escalation", escalation.id);
  }

  /**
   * Adds an item to the Project manager's inbox and sends `build.inbox`, so
   * the server types its pointer into the session of the build's box. An
   * item that the inbox holds already stays as it is.
   */
  async toProjectManager(draft: PmItemDraft): Promise<void> {
    const item = await this.inbox.add(draft);
    if (!item) return;
    await this.emit({
      type: "build.inbox",
      buildId: this.state.id,
      slug: this.state.slug,
      boxId: this.state.boxId,
      item,
    });
  }

  /**
   * Sets each task's status from the open escalations: a task that an open
   * escalation names is `failed`, a task it pauses is `blocked`, and any
   * other task that isn't done can run again.
   */
  async refreshTaskStatuses(): Promise<void> {
    // Every status changes before the first save, so a drive that runs
    // meanwhile never sees a resolved escalation with its task still failed.
    const open = this.openEscalations();
    const changed: { id: string; status: BuildTaskStatus; previous: BuildTaskStatus }[] = [];
    for (const progress of this.state.tasks) {
      if (progress.status === "done") continue;
      const own = open.some((e) => e.taskId === progress.id);
      const paused = open.some((e) => e.tasks.includes(progress.id));
      const status = own ? "failed" : paused ? "blocked" : progress.base ? "running" : "pending";
      if (status === progress.status) continue;
      changed.push({ id: progress.id, status, previous: progress.status });
      progress.status = status;
    }
    if (changed.length === 0) return;
    await this.persist();
    for (const { id, status, previous } of changed) {
      await this.emit(this.taskChanged(id, status, previous));
    }
  }

  /** Records the owner's push answer in the build plan. */
  async recordPush(push: boolean): Promise<void> {
    this.plan.push = push;
    await this.store.savePlan(this.plan);
  }

  /**
   * Posts as the owner to one agent and records the post as a decision.
   * The team chat delivers the post to that agent only; an agent that
   * holds no session yet gets it with the task's decisions when it starts.
   */
  async post(input: OwnerPost): Promise<OwnerPostAnswer> {
    if (!this.team) throw new Error("The engine runs no team chat, so it can't take a post.");
    const message = await this.team.send({ kind: "owner" }, input);
    return { route: "agent", message, decision: await this.decisions.record(message) };
  }

  /** The decisions attached to any of `taskIds`, as a prompt section's body. */
  async decisionsText(taskIds: readonly string[]): Promise<string> {
    return decisionsText(decisionsFor(await this.decisions.list(), taskIds, this.plan));
  }

  /**
   * Flags owner post `message` to the Project manager as a change to the
   * build plan, because `reporter` found that it contradicts `contradicts`.
   * A post flagged already stays as it is.
   */
  async flagPlanChange(
    message: Message,
    reporter: { seat: string; taskId: string | null },
    contradicts: ReadonlyArray<{ criterion: string; reason: string }>,
  ): Promise<BuildDecision | null> {
    const decision = await this.decisions.byMessage(message.id);
    if (!decision || decision.planChange || contradicts.length === 0) return null;
    const from = { kind: "seat" as const, seat: reporter.seat, taskId: reporter.taskId };
    const criteria = [...new Set(contradicts.map((c) => c.criterion))];
    const reason = contradicts.map((c) => `${c.criterion}: ${c.reason}`).join(" ");
    const note = await this.team
      ?.send(from, {
        type: "note",
        to: "project-manager",
        ...(decision.taskId !== null ? { taskId: decision.taskId } : {}),
        ...(decision.milestone !== null ? { milestone: decision.milestone } : {}),
        body: [
          `Plan change: owner post ${message.id} (decision ${decision.id}) contradicts acceptance criteria ${criteria.join(", ")} of the build plan.`,
          reason,
          "The agent works from the post. Change the plan's criteria to match it, or ask the owner.",
        ].join("\n\n"),
      })
      .catch((error: unknown) => {
        this.services.log.warn("Couldn't send a plan change flag", {
          build: this.state.slug,
          error: String(error),
        });
        return null;
      });
    return this.decisions.flag(message.id, {
      criteria,
      reason,
      reportedBy: from,
      messageId: note?.id ?? null,
      flaggedAt: this.now(),
    });
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
        const decisions = await this.decisionsText(taskIds);
        const outcome = await this.runTurn(
          seatCallSpec(role, placement, {
            seat: input.seat,
            key: input.key,
            step: input.step,
            task: decisions === "" ? input.task : { ...input.task, decisions },
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
