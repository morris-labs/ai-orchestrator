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
  type Message,
  type QueuedMessage,
  type SeatPlacement,
  type SessionBrief,
  type SessionRecord,
} from "@aio/contracts";
import { RunCancelled, describeError, type AgentOutcome } from "../../calls/index.js";
import { readJson } from "../../run/files.js";
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
      placement: input.placement,
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

  private async deliver(entry: QueuedMessage): Promise<void> {
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
    }
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
    const placement = ctx.seats.place(entry.seat);
    const reason = freshReason(session, placement, ctx.services.clock.now(), this.settings);
    const packs = await ctx.specialties(session.brief.specialties);
    const decisions = await ctx.decisionsText(session.taskIds);
    const task: RoleTask = {
      ...session.brief,
      repoPath: ctx.worktree.path,
      branch: ctx.state.branch,
      specialties: packs,
      ...(decisions !== "" ? { decisions } : {}),
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
      ...(reason === null && session.sessionId !== null ? { sessionId: session.sessionId } : {}),
    });
    let taken = session;
    if (!(await this.registry.hasTurn(key))) {
      const turn = {
        key,
        messageId: message.id,
        at: this.now(),
        head: await ctx.worktree.head(),
        inputTokens: outcome.tokens.in,
      };
      if (reason === null) {
        await this.registry.addTurn(session.id, turn, outcome.sessionId);
      } else {
        taken = await this.registry.start({
          seat: session.seat,
          taskIds: session.taskIds,
          brief: session.brief,
          step: session.step,
          vendor: outcome.vendor,
          model: outcome.model,
          sessionId: outcome.sessionId,
          placement,
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
