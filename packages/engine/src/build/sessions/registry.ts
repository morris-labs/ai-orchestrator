// The build's `sessions.json` file: every agent session with its seat and
// tasks, the messages that wait for a turn, and what became of each one.
// Every change is saved before the method that made it returns, so the
// registry survives an engine restart.
import {
  SessionRegistrySchema,
  type QueuedMessage,
  type SessionBrief,
  type SessionDelivery,
  type SessionReason,
  type SessionRecord,
  type SessionRegistry,
  type SessionTurn,
  type BuildStep,
  type SeatPlacement,
  type Vendor,
} from "@aio/contracts";
import { readJson, writeJsonAtomic } from "../../run/files.js";

/** A session that started with its first turn. */
export interface SessionStart {
  seat: string;
  taskIds: readonly string[];
  brief: SessionBrief;
  step: BuildStep;
  vendor: Vendor;
  model: string;
  sessionId: string | null;
  placement: SeatPlacement;
  reason: SessionReason;
  /**
   * The session this one takes over from. Absent, a new session replaces
   * every current session of its seat that works for one of its tasks.
   */
  replaces?: string;
  turn: SessionTurn;
}

/** True when a session that works for `taskIds` holds the seat for `taskId`. */
function covers(taskIds: readonly string[], taskId: string | null): boolean {
  return taskId === null ? taskIds.length === 0 : taskIds.includes(taskId);
}

function overlaps(a: readonly string[], b: readonly string[]): boolean {
  return (a.length === 0 && b.length === 0) || a.some((id) => b.includes(id));
}

export class SessionRegistryFile {
  private data: SessionRegistry | null = null;
  private loading: Promise<SessionRegistry> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  /** Reads the file once; later calls return the registry in memory. */
  load(): Promise<SessionRegistry> {
    this.loading ??= (async () => {
      const saved = await readJson(this.path, SessionRegistrySchema);
      this.data = saved ?? SessionRegistrySchema.parse({});
      return this.data;
    })();
    return this.loading;
  }

  /** A copy of the registry as it stands. */
  async snapshot(): Promise<SessionRegistry> {
    return structuredClone(await this.load());
  }

  /** The current session in `seat` for `taskId`: the newest one that no other replaced. */
  async current(seat: string, taskId: string | null): Promise<SessionRecord | undefined> {
    const { sessions } = await this.load();
    return [...sessions]
      .reverse()
      .find((s) => s.seat === seat && s.replacedBy === null && covers(s.taskIds, taskId));
  }

  /** True when a session took a turn under the agent call key `key`. */
  async hasTurn(key: string): Promise<boolean> {
    const { sessions } = await this.load();
    return sessions.some((s) => s.turns.some((t) => t.key === key));
  }

  /** The messages that wait for a turn, oldest first. */
  async queued(): Promise<QueuedMessage[]> {
    return structuredClone((await this.load()).queue);
  }

  /** Records a session and marks the sessions it replaces. */
  start(input: SessionStart): Promise<SessionRecord> {
    return this.change((data) => {
      const id = `S${data.sessions.length + 1}`;
      const { turn, replaces, taskIds, ...rest } = input;
      const replaced = data.sessions.filter((s) =>
        replaces !== undefined
          ? s.id === replaces
          : s.seat === input.seat && s.replacedBy === null && overlaps(s.taskIds, taskIds),
      );
      for (const old of replaced) old.replacedBy = id;
      const record: SessionRecord = {
        id,
        ...rest,
        taskIds: [...taskIds],
        replaces: replaces ?? replaced.at(-1)?.id ?? null,
        replacedBy: null,
        startedAt: turn.at,
        turns: [turn],
      };
      data.sessions.push(record);
      return structuredClone(record);
    });
  }

  /** Adds a finished turn to session `id`, with the vendor session it reported. */
  addTurn(id: string, turn: SessionTurn, sessionId: string | null): Promise<void> {
    return this.change((data) => {
      const session = data.sessions.find((s) => s.id === id);
      if (!session) throw new Error(`The session registry has no session ${id}.`);
      session.turns.push(turn);
      if (sessionId !== null) session.sessionId = sessionId;
    });
  }

  /** Queues a message for a turn, unless it waits already. */
  enqueue(entry: QueuedMessage): Promise<void> {
    return this.change((data) => {
      if (data.queue.some((q) => q.messageId === entry.messageId)) return;
      if (data.deliveries.some((d) => d.messageId === entry.messageId)) return;
      data.queue.push({ ...entry });
    });
  }

  /** Takes a message off the queue and records what became of it. */
  settle(messageId: string, delivery: Omit<SessionDelivery, "messageId">): Promise<void> {
    return this.change((data) => {
      data.queue = data.queue.filter((q) => q.messageId !== messageId);
      data.deliveries.push({ messageId, ...delivery });
    });
  }

  /** Applies `edit` to the registry and saves it; changes run one at a time. */
  private change<T>(edit: (data: SessionRegistry) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const data = await this.load();
      const result = edit(data);
      await writeJsonAtomic(this.path, data);
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}
