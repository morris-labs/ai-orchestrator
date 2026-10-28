// The engine side of the lease protocol (contracts `lease.ts`). Requests go
// out as `lease.request` control frames to every subscribed server socket;
// the first `lease.response` for a lease id settles it.
import { randomUUID } from "node:crypto";
import {
  LeaseRequestFrameSchema,
  LeaseResponseSchema,
  type LeaseRequest,
  type LeaseRequestFrame,
  type LeaseResponse,
} from "@agentbox/contracts";
import type { Logger } from "../api/core-interface.js";
import type { LeaseActual, LeaseBroker } from "../core.js";

/** What a caller asks for; the broker assigns `leaseId` when it's absent. */
export type LeaseAsk = Omit<LeaseRequest, "leaseId"> & { leaseId?: string };

export type LeaseGrant = Extract<LeaseResponse, { decision: "granted" }>;

/** A server socket that can carry lease frames. */
export interface LeaseTransport {
  send(frame: LeaseRequestFrame): void;
}

export interface LeaseBrokerOptions {
  log: Logger;
  now?: () => Date;
  newLeaseId?: () => string;
  /**
   * How long a sent request may go unanswered before the broker sends it
   * again, for a server that lost it across a reconnect.
   */
  resendAfterMs?: number;
  /** How often the broker checks for requests to resend. */
  tickMs?: number;
}

interface Pending {
  frame: LeaseRequestFrame;
  resolve: (r: LeaseResponse) => void;
  reject: (e: Error) => void;
  /** When the frame last went to a transport; `null` while none was subscribed. */
  sentAt: number | null;
  detachAbort: () => void;
  signal: AbortSignal | undefined;
}

export class LeaseBrokerClosedError extends Error {
  constructor() {
    super("The lease broker closed before the server answered.");
    this.name = "LeaseBrokerClosedError";
  }
}

/**
 * The core's `LeaseBroker` over the event socket. A request waits while no
 * server is subscribed, and a grant that expired on the way is asked for
 * again under a new lease id.
 */
export class EngineLeaseBroker implements LeaseBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly transports = new Set<LeaseTransport>();
  private readonly now: () => Date;
  private readonly newLeaseId: () => string;
  private readonly resendAfterMs: number;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly options: LeaseBrokerOptions) {
    this.now = options.now ?? (() => new Date());
    this.newLeaseId = options.newLeaseId ?? (() => `L-${randomUUID()}`);
    this.resendAfterMs = options.resendAfterMs ?? 30_000;
    this.timer = setInterval(() => this.resendStale(), options.tickMs ?? 5_000);
    this.timer.unref();
  }

  /** The lease ids that have no answer yet. */
  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  /**
   * The core's entry point: asks the server under the core's own lease id.
   * Rejects when `signal` aborts, so a cancelled run stops waiting. The
   * response's `leaseId` is the one to settle: it differs from the request's
   * when an expired grant made the broker ask again.
   */
  acquire(request: LeaseRequest, signal?: AbortSignal): Promise<LeaseResponse> {
    return this.request(request, { signal });
  }

  /**
   * Sends a `lease.request` frame and resolves with the server's answer.
   * Rejects when `signal` aborts or the broker closes.
   */
  request(ask: LeaseAsk, options: { signal?: AbortSignal } = {}): Promise<LeaseResponse> {
    if (this.closed) return Promise.reject(new LeaseBrokerClosedError());
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<LeaseResponse>((resolve, reject) => {
      this.enqueue({ ...ask, leaseId: ask.leaseId ?? this.newLeaseId() }, resolve, reject, signal);
    });
  }

  /** True while a grant can still start a call: before its `expiresAt`. */
  isUsable(grant: LeaseGrant): boolean {
    return Date.parse(grant.expiresAt) > this.now().getTime();
  }

  /**
   * Notes that a lease finished. The core emits the `lease.settled` event,
   * which carries the actual use to the server, so the broker sends nothing.
   */
  settle(leaseId: string, actual: LeaseActual): void {
    this.options.log.debug("Lease settled", {
      leaseId,
      tokensIn: actual.tokens.in,
      tokensOut: actual.tokens.out,
    });
  }

  /**
   * Adds a subscribed server socket and sends it every unanswered request.
   * Returns the function that removes it.
   */
  attach(transport: LeaseTransport): () => void {
    this.transports.add(transport);
    const at = this.now().getTime();
    for (const p of this.pending.values()) {
      this.sendTo(transport, p.frame);
      p.sentAt = at;
    }
    return () => this.transports.delete(transport);
  }

  /** Settles the request a `lease.response` answers. Unknown or repeated ids are ignored. */
  handleResponse(response: LeaseResponse): void {
    const parsed = LeaseResponseSchema.parse(response);
    const p = this.pending.get(parsed.leaseId);
    if (!p) {
      this.options.log.debug("Ignored a lease response with no pending request", {
        leaseId: parsed.leaseId,
      });
      return;
    }
    this.pending.delete(parsed.leaseId);
    p.detachAbort();
    if (parsed.decision === "granted" && !this.isUsable(parsed)) {
      // The grant expired on the way. Ask again under a new id, because the
      // server answers a repeated id with the same, expired, response.
      const { type: _type, leaseId: _old, ...ask } = p.frame;
      this.options.log.info("A lease grant arrived expired; asking again", {
        leaseId: parsed.leaseId,
      });
      this.enqueue({ ...ask, leaseId: this.newLeaseId() }, p.resolve, p.reject, p.signal);
      return;
    }
    p.resolve(parsed);
  }

  /** Rejects every pending request and stops the resend timer. */
  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const p of this.pending.values()) {
      p.detachAbort();
      p.reject(new LeaseBrokerClosedError());
    }
    this.pending.clear();
    this.transports.clear();
  }

  /** Sends again every request that has waited longer than `resendAfterMs`. */
  resendStale(): void {
    if (this.transports.size === 0) return;
    const at = this.now().getTime();
    for (const p of this.pending.values()) {
      if (p.sentAt === null || at - p.sentAt >= this.resendAfterMs) {
        this.broadcast(p.frame);
        p.sentAt = at;
      }
    }
  }

  private enqueue(
    request: LeaseAsk & { leaseId: string },
    resolve: (r: LeaseResponse) => void,
    reject: (e: Error) => void,
    signal: AbortSignal | undefined,
  ): void {
    const frame = LeaseRequestFrameSchema.parse({ type: "lease.request", ...request });
    let detachAbort = () => {};
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    if (signal) {
      const onAbort = () => {
        this.pending.delete(frame.leaseId);
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      detachAbort = () => signal.removeEventListener("abort", onAbort);
    }
    const p: Pending = { frame, resolve, reject, sentAt: null, detachAbort, signal };
    this.pending.set(frame.leaseId, p);
    if (this.transports.size > 0) {
      this.broadcast(frame);
      p.sentAt = this.now().getTime();
    }
  }

  private broadcast(frame: LeaseRequestFrame): void {
    for (const t of this.transports) this.sendTo(t, frame);
  }

  private sendTo(transport: LeaseTransport, frame: LeaseRequestFrame): void {
    try {
      transport.send(frame);
    } catch (err) {
      this.options.log.warn("Couldn't send a lease request", {
        leaseId: frame.leaseId,
        error: String(err),
      });
    }
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The lease request was aborted.");
}
