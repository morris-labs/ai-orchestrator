// Messages that the server sends a box's session on its own, such as the
// request to hold edits while a review run works on the box's branch and
// the release when the run ends. Delivery types nothing into a session that
// shows a dialog or holds unsent text (see `delivery.ts`), so a message that
// the session can't take waits and goes out on a later attempt. A box's
// messages go out in the order the server sent them.
//
// A message for a stopped box, or for a session that never takes one, such
// as a Codex session, is dropped: there is no session to tell. The waiting
// messages live in memory only; after a restart, a run that ends still
// sends its release.
import type { DeliveryRequest, DeliveryResult } from "./delivery.js";

export interface SessionMessagesDeps {
  deliver(boxId: string, request: DeliveryRequest): Promise<DeliveryResult>;
  log: (message: string) => void;
  /** How long to wait before the next attempt. Default: 5 seconds. */
  retryMs?: number;
  /** How long a message waits before the server gives up on it. Default: 30 minutes. */
  giveUpMs?: number;
}

export interface SendOptions {
  /**
   * A message that this one takes back. When that message still waits for
   * the box, the server drops it and doesn't send this one either: a
   * release for a hold that never reached the session tells it nothing.
   * When an attempt types that message at the time, this one waits for the
   * outcome: it goes out after a message the session took, and is dropped
   * with one it didn't.
   */
  withdraws?: string;
}

interface Waiting {
  text: string;
  since: number;
  /**
   * The message that took this one back while an attempt typed it. It goes
   * out when this one did, and the two drop together when it didn't.
   */
  withdrawnBy?: Waiting;
}

export class SessionMessages {
  private readonly queues = new Map<string, Waiting[]>();
  /** The message that each box's attempt under way types. */
  private readonly typing = new Map<string, Waiting>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** The last reason each box's message waited, so the log says it once. */
  private readonly reasons = new Map<string, string>();
  private closed = false;

  constructor(private readonly deps: SessionMessagesDeps) {}

  /** Sends `text` to box `boxId`'s session now, or once the session can take it. */
  send(boxId: string, text: string, options: SendOptions = {}): void {
    const queue = this.queues.get(boxId) ?? [];
    const message: Waiting = { text, since: Date.now() };
    if (options.withdraws !== undefined) {
      const at = queue.findIndex((m) => m.text === options.withdraws);
      const withdrawn = queue[at];
      if (withdrawn && withdrawn === this.typing.get(boxId)) {
        // The session might take it yet, so this message waits for the outcome.
        withdrawn.withdrawnBy = message;
      } else if (withdrawn) {
        queue.splice(at, 1);
        return;
      }
    }
    queue.push(message);
    this.queues.set(boxId, queue);
    this.kick(boxId);
  }

  /** Resolves once every attempt under way has finished. */
  async idle(): Promise<void> {
    for (;;) {
      const chains = [...this.chains.values()];
      await Promise.all(chains);
      if ([...this.chains.values()].every((c, i) => c === chains[i])) return;
    }
  }

  /** Stops the attempts that wait. */
  close(): void {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private kick(boxId: string): void {
    clearTimeout(this.timers.get(boxId));
    this.timers.delete(boxId);
    const next = (this.chains.get(boxId) ?? Promise.resolve())
      .then(() => this.drain(boxId))
      .catch((err: unknown) => {
        this.deps.log(`A message for box ${boxId} failed: ${(err as Error).message}`);
        this.later(boxId);
      });
    this.chains.set(boxId, next);
  }

  private async drain(boxId: string): Promise<void> {
    const queue = this.queues.get(boxId) ?? [];
    for (;;) {
      const head = queue[0];
      if (!head || this.closed) return;
      this.typing.set(boxId, head);
      let result: DeliveryResult;
      try {
        result = await this.deps.deliver(boxId, { text: head.text });
      } finally {
        this.typing.delete(boxId);
      }
      if (!result.delivered && head.withdrawnBy) {
        // Withdrawn while typed, and the session didn't take it: neither goes out.
        const release = head.withdrawnBy;
        queue.shift();
        const at = queue.indexOf(release);
        if (at >= 0) queue.splice(at, 1);
        continue;
      }
      if (result.delivered) {
        queue.shift();
        this.reasons.delete(boxId);
        continue;
      }
      if (result.stopped || result.unsupported) {
        this.deps.log(`Dropped a message for box ${boxId}: ${result.reason}`);
        queue.shift();
        continue;
      }
      if (Date.now() - head.since >= (this.deps.giveUpMs ?? 30 * 60_000)) {
        this.deps.log(`Gave up on a message for box ${boxId}: ${result.reason}`);
        queue.shift();
        continue;
      }
      if (this.reasons.get(boxId) !== result.reason) {
        this.reasons.set(boxId, result.reason);
        this.deps.log(`A message for box ${boxId} waits: ${result.reason}`);
      }
      this.later(boxId);
      return;
    }
  }

  private later(boxId: string): void {
    if (this.closed) return;
    const timer = setTimeout(() => this.kick(boxId), this.deps.retryMs ?? 5000);
    timer.unref();
    this.timers.set(boxId, timer);
  }
}
