// One build's team chat: its message files, the tokens of the agents that
// may send to it, and the listeners that later deliver each message. The
// `TeamBus` opens one channel per build.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  MessageSchema,
  SendMessageInputSchema,
  type Message,
  type MessageParty,
} from "@aio/contracts";
import type { z } from "zod";
import { systemClock, type Clock, type EventDraft, type TeamAttachment } from "../core.js";
import { readJson, writeJsonAtomic } from "../run/files.js";
import { routeMessage, type RouteTask } from "./routing.js";

/** The agent a token stands for: a seat and the task it works on. */
export interface TeamMember {
  seat: string;
  /** `null` for a seat that works on no one task, such as the Project manager. */
  taskId: string | null;
}

/** A token for one agent call. Revoke it when the call ends. */
export interface TeamPass {
  /** What the vendor adapter needs to attach the bus to the call. */
  attachment: TeamAttachment;
  /** Ends the token; the bus refuses it from then on. Safe to call twice. */
  revoke(): void;
}

export interface TeamChannelOptions {
  buildId: string;
  /** The directory of the message files, such as `.aio/builds/SLUG/messages`. */
  dir: string;
  /** The plan's tasks, for routing file requests; a function is read on every message. */
  tasks: readonly RouteTask[] | (() => readonly RouteTask[]);
  /** Sends an event, such as the build context's `emit`. */
  emit(draft: EventDraft): void | Promise<void>;
  /**
   * Checks a message before the channel saves it, such as against a rate
   * limit. Throw `MessageRefused` to refuse it; the sender reads the reason.
   * Return a message to save that one instead, such as the same message
   * routed elsewhere.
   */
  check?(message: Message): void | Message | Promise<void | Message>;
  clock?: Clock;
}

/** A message the engine refuses to save; `message` tells the sender why. */
export class MessageRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageRefused";
  }
}

/** How a channel reaches the bus that opened it. */
export interface TeamRegistry {
  /** Registers a token for `member` and returns its attachment and revoke function. */
  issue(channel: TeamChannel, member: TeamMember): TeamPass;
  /** Forgets the channel and every token it issued. */
  release(channel: TeamChannel): void;
}

const MESSAGE_FILE = /^M([1-9][0-9]*)\.json$/;

/** The text of a zod error, one issue per clause, for a sender to read. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
}

export class TeamChannel {
  readonly buildId: string;
  readonly dir: string;
  private readonly listeners = new Set<(message: Message) => void>();
  private chain: Promise<unknown> = Promise.resolve();
  /** The number of the last saved message, once read from the directory. */
  private last: number | null = null;
  private closed = false;

  constructor(
    private readonly options: TeamChannelOptions,
    private readonly registry: TeamRegistry,
  ) {
    this.buildId = options.buildId;
    this.dir = options.dir;
  }

  /**
   * Issues a token for one agent call by `member`. The engine attaches it to
   * that call only and revokes it when the call ends, so a message reaches
   * the bus only while its sender's call runs.
   */
  admit(member: TeamMember): TeamPass {
    if (this.closed) throw new Error(`The team chat of build ${this.buildId} is closed.`);
    return this.registry.issue(this, member);
  }

  /**
   * Routes, saves, and announces a message from `from`. Agents reach this
   * through the `send_message` tool, with `from` set from their token; the
   * engine calls it directly for the owner. Throws `MessageRefused` for
   * input that isn't a valid message.
   */
  send(from: MessageParty, input: unknown): Promise<Message> {
    const run = this.chain.then(() => this.save(from, input));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async save(from: MessageParty, input: unknown): Promise<Message> {
    const parsed = SendMessageInputSchema.safeParse(input);
    if (!parsed.success) throw new MessageRefused(describeIssues(parsed.error));
    const draft = parsed.data;
    const replied = draft.replyTo === undefined ? undefined : await this.replied(draft.replyTo);
    const { to, routing } = routeMessage(draft, from, this.tasks(), replied);
    // The task defaults to the replied message's, then to the sender's, then
    // to the addressee's.
    const taskId =
      draft.taskId ??
      replied?.taskId ??
      (from.kind === "seat" ? from.taskId : null) ??
      (to.kind === "seat" ? to.taskId : null);
    const milestone = draft.milestone ?? replied?.milestone ?? null;
    if (taskId === null && milestone === null) {
      throw new MessageRefused("The message needs a task or a milestone: set taskId or milestone.");
    }
    const number = (await this.lastNumber()) + 1;
    const drafted = MessageSchema.parse({
      version: 1,
      id: `M${number}`,
      buildId: this.buildId,
      from,
      to,
      routing,
      type: draft.type,
      taskId,
      milestone,
      paths: draft.paths ?? [],
      body: draft.body,
      ...(replied ? { replyTo: replied.id, thread: replied.thread ?? replied.id } : {}),
      createdAt: new Date((this.options.clock ?? systemClock).now()).toISOString(),
    });
    const message = (await this.options.check?.(drafted)) ?? drafted;
    await writeJsonAtomic(join(this.dir, `${message.id}.json`), message);
    this.last = number;
    await this.options.emit({ type: "message.sent", message });
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // A listener's failure is its own; the message is saved and sent.
      }
    }
    return message;
  }

  /** The saved message that a reply replies to; refuses an ID the build doesn't have. */
  private async replied(id: string): Promise<Message> {
    const message = await readJson(join(this.dir, `${id}.json`), MessageSchema);
    if (!message) {
      throw new MessageRefused(
        `The build has no message ${id} to reply to. Set replyTo to the ID of the message you answer.`,
      );
    }
    return message;
  }

  /** Every saved message of the build, oldest first. */
  async list(): Promise<Message[]> {
    const numbers = await this.numbers();
    const messages: Message[] = [];
    for (const n of numbers) {
      const message = await readJson(join(this.dir, `M${n}.json`), MessageSchema);
      if (message) messages.push(message);
    }
    return messages;
  }

  /** Calls `listener` with each message saved from now on. Returns a function that stops it. */
  onMessage(listener: (message: Message) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Revokes every token of the channel; the bus forgets it. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.registry.release(this);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private tasks(): readonly RouteTask[] {
    const { tasks } = this.options;
    return typeof tasks === "function" ? tasks() : tasks;
  }

  private async lastNumber(): Promise<number> {
    if (this.last === null) this.last = (await this.numbers()).at(-1) ?? 0;
    return this.last;
  }

  private async numbers(): Promise<number[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return names
      .map((name) => MESSAGE_FILE.exec(name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }
}
