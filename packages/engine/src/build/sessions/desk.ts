// The session desk of a build: it records the session of every seat call,
// and turns each team chat message for an agent into a turn of that agent's
// session. A seat takes one turn at a time, so a message for an agent whose
// turn is under way waits for it, and two messages for one session run as
// two turns in order.
import {
  BuildSessionSettingsSchema,
  MessageSchema,
  OwnerPostTurnAnswerSchema,
  type BuildSessionSettings,
  type BuildStep,
  type EscalationKind,
  type Message,
  type RoleDefinition,
  type QueuedMessage,
  type SeatPlacement,
  type SessionBrief,
  type SessionRecord,
  type Vendor,
} from "@aio/contracts";
import { RunCancelled, describeError, type AgentOutcome } from "../../calls/index.js";
import { readJson } from "../../run/files.js";
import { escalationForCallError } from "../escalations.js";
import { outsideWritable } from "../gate.js";
import { writablePaths } from "../roles/index.js";
import { readTestLock } from "../test-lock.js";
import type { BuildContext } from "../context.js";
import type { RoleTask } from "../roles/index.js";
import { ownerPostAnswer } from "../owner/index.js";
import { DEFAULT_TURN_ANSWER, freshPrompt, resumePrompt } from "./prompts.js";
import { SessionRegistryFile } from "./registry.js";
import { freshReason } from "./rule.js";

/** A seat call's first turn, as the desk records it. */
export interface SeatSession {
  seat: string;
  taskIds: readonly string[];
  task: RoleTask;
  /** The specialty names of the task. */
  specialties: readonly string[];
  step: BuildStep;
  key: string;
  placement: SeatPlacement;
  /** The vendor a rule keeps the seat's agents off, which every later turn keeps. */
  otherThan?: Vendor;
  outcome: AgentOutcome<unknown>;
}

/** The task as a session's agent got it, without the context of one attempt. */
export function briefOf(task: RoleTask, specialties: readonly string[]): SessionBrief {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    ownedFiles: [...task.ownedFiles],
    contracts: [...(task.contracts ?? [])],
    criteria: task.criteria.map((c) => ({ id: c.id, text: c.text })),
    tests: [...(task.tests ?? [])],
    specialties: [...specialties],
  };
}

/** True when `party` is the seat `seat` on one of `taskIds`, or on no task when `taskIds` is empty. */
function isMember(party: Message["from"], seat: string, taskIds: readonly string[]): boolean {
  if (party.kind !== "seat" || party.seat !== seat) return false;
  return party.taskId === null ? taskIds.length === 0 : taskIds.includes(party.taskId);
}

export class SessionDesk {
  readonly registry: SessionRegistryFile;
  /** The end of the last turn queued for each seat; it never rejects. */
  private readonly tails = new Map<string, Promise<void>>();
  /** The tasks of each seat call queued or under way, by seat. */
  private readonly working = new Map<string, Set<readonly string[]>>();
  /** The messages whose turn is queued or under way. */
  private readonly scheduled = new Set<string>();
  /** Work the desk started that `idle()` waits for. */
  private readonly work = new Set<Promise<unknown>>();

  constructor(private readonly ctx: BuildContext) {
    this.registry = new SessionRegistryFile(ctx.store.path("sessions.json"));
  }

  private get settings(): BuildSessionSettings {
    return this.ctx.services.sessions ?? BuildSessionSettingsSchema.parse({});
  }

  /**
   * Runs `turn` when every turn queued before it for `seat` has ended, so a
   * seat takes one turn at a time. A seat call names the plan tasks its
   * agent works for, so a message for one of them waits for the agent
   * instead of finding no session.
   */
  run<T>(seat: string, turn: () => Promise<T>, taskIds?: readonly string[]): Promise<T> {
    const before = this.tails.get(seat) ?? Promise.resolve();
    const working = this.working.get(seat) ?? new Set<readonly string[]>();
    // A copy of its own, so two calls with one task list each count.
    const mine = taskIds ? [...taskIds] : null;
    if (mine) working.add(mine);
    this.working.set(seat, working);
    const result = before.then(turn);
    const ended = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(
      seat,
      ended.then(() => {
        if (mine) working.delete(mine);
      }),
    );
    return result;
  }

  /** True when a seat call queued or under way works for `taskId` in `seat`. */
  private awaited(seat: string, taskId: string | null): boolean {
    for (const taskIds of this.working.get(seat) ?? []) {
      if (taskId === null ? taskIds.length === 0 : taskIds.includes(taskId)) return true;
    }
    return false;
  }

  /**
   * Records the session of a seat call that started a new agent. A cached
   * call that a restarted build returns again is recorded once.
   */
  async started(input: SeatSession): Promise<void> {
    if (await this.registry.hasTurn(input.key)) return;
    await this.registry.start({
      seat: input.seat,
      taskIds: input.taskIds,
      brief: briefOf(input.task, input.specialties),
      step: input.step,
      vendor: input.outcome.vendor,
      model: input.outcome.model,
      sessionId: input.outcome.sessionId,
      ...(input.outcome.accountFolder !== undefined
        ? { accountFolder: input.outcome.accountFolder }
        : {}),
      placement: input.placement,
      ...(input.otherThan ? { otherThan: input.otherThan } : {}),
      reason: "step",
      turn: {
        key: input.key,
        messageId: null,
        at: this.now(),
        head: await this.ctx.worktree.head(),
        inputTokens: input.outcome.tokens.in,
      },
    });
  }

  /**
   * Takes a message that the team chat saved. A message for a seat whose
   * agent has a session, or whose turn is under way, waits in the queue for
   * that seat's next turn; any other message isn't the desk's to deliver.
   */
  receive(message: Message): void {
    if (message.to.kind !== "seat") return;
    const entry = { messageId: message.id, seat: message.to.seat, taskId: message.to.taskId };
    this.track(
      (async () => {
        const session = await this.registry.current(entry.seat, entry.taskId);
        if (!session && !this.awaited(entry.seat, entry.taskId)) return;
        await this.registry.enqueue(entry);
        this.schedule(entry);
      })(),
    );
  }

  /** Queues a turn for every message that waits in the registry, such as after a restart. */
  resumePending(): void {
    this.track(
      (async () => {
        for (const entry of await this.registry.queued()) this.schedule(entry);
      })(),
    );
  }

  /** Waits until no message turn is queued or under way. */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch((error: unknown) => {
      this.ctx.services.log.error("The session desk failed", {
        build: this.ctx.state.slug,
        error: describeError(error),
      });
    });
    this.work.add(tracked);
    void tracked.finally(() => this.work.delete(tracked));
  }

  private schedule(entry: QueuedMessage): void {
    if (this.scheduled.has(entry.messageId)) return;
    this.scheduled.add(entry.messageId);
    this.track(this.run(entry.seat, () => this.deliver(entry)));
  }

  /**
   * Delivers a message once the drive lets go of the worktree: a write turn
   * mustn't change files under the drive, and a read-only turn's tree guard
   * mustn't see the drive's changes. A failed turn's escalation is raised
   * before the drive gets the worktree back, so the drive sees what it paused.
   */
  private deliver(entry: QueuedMessage): Promise<void> {
    return this.ctx.worktreeLock.run(() => this.deliverNow(entry));
  }

  private async deliverNow(entry: QueuedMessage): Promise<void> {
    try {
      await this.turn(entry);
      this.scheduled.delete(entry.messageId);
    } catch (error) {
      this.scheduled.delete(entry.messageId);
      if (error instanceof RunCancelled) {
        // The message stays queued. A stopped engine delivers it after a
        // restart; a new drive that cut the turn short delivers it now.
        if (!this.ctx.signal.aborted) this.schedule(entry);
        return;
      }
      this.ctx.services.log.warn("Couldn't deliver a team chat message", {
        build: this.ctx.state.slug,
        message: entry.messageId,
        error: describeError(error),
      });
      await this.registry.settle(entry.messageId, {
        session: null,
        status: "failed",
        at: this.now(),
        note: describeError(error),
      });
      await this.escalateFailure(entry, error);
    }
  }

  /**
   * Raises an escalation for a message that its addressee never got. It
   * pauses the message's task, or the sender's, when that is a plan task;
   * otherwise the build waits for it.
   */
  private async escalateFailure(entry: QueuedMessage, error: unknown): Promise<void> {
    const addressee = `the ${entry.seat}${entry.taskId ? ` (task ${entry.taskId})` : ""}`;
    const cause = escalationForCallError(error, null);
    await this.escalateTurn(entry, {
      kind: cause?.kind ?? "agent_call",
      summary: `Message ${entry.messageId} to ${addressee} wasn't delivered: ${describeError(error)}`,
      details: [
        `The engine couldn't give message ${entry.messageId} to ${addressee}, so that agent never read it. Answer the sender yourself on the team chat, or fix the cause and resolve the escalation; the sender can then send the message again.`,
        "",
        `Error: ${describeError(error)}`,
      ].join("\n"),
    });
  }

  /**
   * Raises an escalation about a message turn, with the message's body. It
   * pauses the message's task, or the sender's, when that is a plan task;
   * otherwise the build waits for it.
   */
  private async escalateTurn(
    entry: QueuedMessage,
    draft: { kind?: EscalationKind; summary: string; details: string },
  ): Promise<void> {
    const { ctx } = this;
    const message = await readJson(
      ctx.store.path("messages", `${entry.messageId}.json`),
      MessageSchema,
    ).catch(() => null);
    const planTask = (id: string | null | undefined) =>
      id && ctx.state.tasks.some((t) => t.id === id) ? id : null;
    const sender = message?.from.kind === "seat" ? message.from.taskId : null;
    await ctx.escalate({
      kind: draft.kind ?? "agent_call",
      level: "project_manager",
      taskId: planTask(entry.taskId) ?? planTask(sender),
      summary: draft.summary,
      details: [
        draft.details,
        "",
        message ? `Message body:\n\n${message.body}` : "The message file is missing.",
      ].join("\n"),
    });
  }

  /**
   * The paths of `changed` that the turn's seat may not change: those
   * outside its writable paths for `task`, and locked tests, which only a
   * test dispute changes.
   */
  private async refusedChanges(
    role: RoleDefinition,
    task: RoleTask,
    changed: readonly string[],
  ): Promise<string[]> {
    const outside = outsideWritable(changed, writablePaths(role, task));
    const lock = await readTestLock(this.ctx.store);
    const locked = new Set((lock?.files ?? []).map((f) => f.path));
    return [...new Set([...outside, ...changed.filter((p) => locked.has(p))])].sort();
  }

  /** One message turn: a resume of the addressee's session, or a fresh agent that takes it over. */
  private async turn(entry: QueuedMessage): Promise<void> {
    const { ctx } = this;
    const message = await readJson(
      ctx.store.path("messages", `${entry.messageId}.json`),
      MessageSchema,
    );
    if (!message) throw new Error(`Message ${entry.messageId} has no file.`);
    const session = await this.registry.current(entry.seat, entry.taskId);
    if (!session) {
      throw new Error(
        `No agent session holds the ${entry.seat} seat${entry.taskId ? ` for task ${entry.taskId}` : ""}.`,
      );
    }
    const key = `message-${message.id}`;
    const role = ctx.role(entry.seat);
    // The rule that kept the session's first agent off a vendor holds for
    // every turn. With the single-vendor setting, that rule only made the
    // first agent fresh, so it didn't share the other seat's session; the
    // session a turn resumes is the seat's own.
    const placement = {
      ...ctx.seats.place(entry.seat, session.otherThan ? { otherThan: session.otherThan } : {}),
      fresh: false,
    };
    const reason = freshReason(session, placement, ctx.services.clock.now(), this.settings);
    const packs = await ctx.specialties(session.brief.specialties);
    const decisions = await ctx.decisionsText(session.taskIds);
    const task: RoleTask = {
      ...session.brief,
      repoPath: ctx.worktree.path,
      branch: ctx.state.branch,
      specialties: packs,
      ...(decisions !== "" ? { decisions } : {}),
      ...(ctx.team ? { teamChat: true } : {}),
    };
    // An owner post's turn also reports the criteria the post contradicts.
    const fromOwner = message.from.kind === "owner";
    const answer = fromOwner ? ownerPostAnswer(ctx.plan.criteria) : DEFAULT_TURN_ANSWER;
    const prompt =
      reason === null
        ? resumePrompt(message, await this.commitsSince(session), answer)
        : freshPrompt({
            role,
            task,
            reason,
            thread: await this.thread(session, message),
            message,
            answer,
          });
    // A turn that writes records what it changed, so the task gate doesn't
    // count it against another seat's attempt.
    const writes = role.permission.access === "write";
    const before = writes ? await ctx.worktree.snapshot() : null;
    const outcome = await ctx.callTurn({
      seat: entry.seat,
      taskId: entry.taskId,
      key,
      step: session.step,
      task,
      prompt,
      placement,
      specialties: packs,
      output: answer.output,
      ...(reason === null && session.sessionId !== null
        ? {
            sessionId: session.sessionId,
            ...(session.accountFolder !== undefined
              ? { sessionFolder: session.accountFolder }
              : {}),
          }
        : {}),
    });
    let taken = session;
    let refused: string[] = [];
    if (!(await this.registry.hasTurn(key))) {
      let changed = before ? await ctx.worktree.changedSinceSnapshot(before) : [];
      // A turn may change only what its seat may: the engine puts back the rest.
      if (before && changed.length > 0) {
        refused = await this.refusedChanges(role, task, changed);
        if (refused.length > 0) {
          await ctx.worktree.restoreSnapshot(before, refused);
          changed = changed.filter((p) => !refused.includes(p));
        }
      }
      const turn = {
        key,
        messageId: message.id,
        at: this.now(),
        head: await ctx.worktree.head(),
        inputTokens: outcome.tokens.in,
        ...(changed.length > 0 ? { changed } : {}),
      };
      if (reason === null) {
        await this.registry.addTurn(session.id, turn, outcome.sessionId, outcome.accountFolder);
      } else {
        taken = await this.registry.start({
          seat: session.seat,
          taskIds: session.taskIds,
          brief: session.brief,
          step: session.step,
          vendor: outcome.vendor,
          model: outcome.model,
          sessionId: outcome.sessionId,
          ...(outcome.accountFolder !== undefined ? { accountFolder: outcome.accountFolder } : {}),
          placement,
          ...(session.otherThan ? { otherThan: session.otherThan } : {}),
          reason,
          replaces: session.id,
          turn,
        });
      }
    }
    await this.registry.settle(message.id, {
      session: taken.id,
      status: "delivered",
      at: this.now(),
    });
    if (refused.length > 0) {
      const files = refused.join(", ");
      await this.escalateTurn(entry, {
        summary: `The ${entry.seat} changed ${files} in its turn for message ${message.id}, which it may not change. The engine put them back.`,
        details: [
          `In its turn for message ${message.id}, the ${entry.seat}${entry.taskId ? ` (task ${entry.taskId})` : ""} changed files outside its writable paths, or locked tests: ${files}. The engine put each one back the way it was before the turn.`,
          "Tell the agent what it may change, or move the change to the seat that owns the files, then resolve the escalation.",
        ].join("\n\n"),
      });
    }
    if (fromOwner) {
      const answered = OwnerPostTurnAnswerSchema.safeParse(outcome.output);
      const contradicts = answered.success ? answered.data.contradicts : [];
      // The post is delivered; a flag that fails to save is only logged.
      await ctx
        .flagPlanChange(message, { seat: entry.seat, taskId: entry.taskId }, contradicts)
        .catch((error: unknown) => {
          ctx.services.log.warn("Couldn't flag an owner post as a plan change", {
            build: ctx.state.slug,
            message: message.id,
            error: describeError(error),
          });
        });
    }
  }

  /**
   * The commits on the build branch since the session's last turn, as `SHA
   * subject` lines, oldest first; `null` when the branch no longer holds the
   * commit of that turn.
   */
  private async commitsSince(session: SessionRecord): Promise<string[] | null> {
    const head = session.turns.at(-1)?.head;
    if (!head) return null;
    const { git } = this.ctx.worktree;
    if (!(await git.ok(["merge-base", "--is-ancestor", head, "HEAD"]))) return null;
    const out = await git.run(["log", "--reverse", "--format=%h %s", `${head}..HEAD`]);
    return out.split("\n").filter((line) => line.trim() !== "");
  }

  /** The saved messages to and from the session's seat on its tasks, oldest first, without `message`. */
  private async thread(session: SessionRecord, message: Message): Promise<Message[]> {
    const all = (await this.ctx.team?.list()) ?? [];
    return all.filter(
      (m) =>
        m.id !== message.id &&
        (isMember(m.from, session.seat, session.taskIds) ||
          isMember(m.to, session.seat, session.taskIds)),
    );
  }

  private now(): string {
    return new Date(this.ctx.services.clock.now()).toISOString();
  }
}
