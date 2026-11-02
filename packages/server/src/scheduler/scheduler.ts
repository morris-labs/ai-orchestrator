// The lease scheduler. Before each model call an engine asks for a lease;
// the scheduler grants it, moves the role to another vendor under its
// ceiling, or tells the run to pause until a window resets. The rules follow
// "Usage tracking and rebalancing" in the review pipeline design: review and
// disprove roles fall back to the next vendor, and the fixer stays with
// Claude, so a Claude over its ceiling pauses the run.
import { VENDOR_ROLES } from "@aio/contracts";
import type {
  AioEvent,
  Ceilings,
  CeilingsOverride,
  GlobalSettings,
  LeaseRequest,
  LeaseResponse,
  Vendor,
} from "@aio/contracts";
import type { EventInput } from "../api/core-interface.js";
import type { UsageService } from "../usage/usage-service.js";

export { VENDOR_ROLES };

export const DEFAULT_FALLBACK_ORDER: readonly Vendor[] = ["codex", "copilot", "claude"];
export const DEFAULT_GRANT_TTL_MS = 10 * 60 * 1000;
/** How long a run pauses when the vendor's reset time is unknown. */
export const UNKNOWN_RESET_PAUSE_MS = 15 * 60 * 1000;
const CACHE_LIMIT = 10_000;
/** How many runs' `role.reassigned` announcements the scheduler remembers. */
export const ANNOUNCED_RUN_LIMIT = 1000;

export interface SchedulerOptions {
  usage: UsageService;
  settings: () => GlobalSettings;
  projectCeilings: (projectId: string) => Promise<CeilingsOverride | undefined>;
  /** The run's current round, for `role.reassigned`. */
  runRound: (runId: string) => number;
  emit: (event: EventInput) => AioEvent;
  now?: () => Date;
  grantTtlMs?: number;
  fallbackOrder?: Vendor[];
  /**
   * Whether a vendor can take a redirected call in a run: set up, and not
   * known to be failing in that run. Absent means every vendor is usable.
   * `VendorHealth.usable` is the usual source.
   */
  usable?: (runId: string, vendor: Vendor) => boolean;
}

/**
 * Tracks vendors that fail in each run, from `agent.finished` events. A
 * vendor whose last call in a run ended in an error or a timeout is failing
 * in that run until one of its calls succeeds there. A scheduler doesn't
 * redirect a role to a failing vendor.
 */
export class VendorHealth {
  private readonly failing = new Map<string, Set<Vendor>>();
  private readonly order: string[] = [];

  constructor(private readonly maxRuns = 1000) {}

  ingest(event: AioEvent): void {
    if (event.type !== "agent.finished") return;
    if (event.outcome === "error" || event.outcome === "timeout") {
      let set = this.failing.get(event.runId);
      if (!set) {
        set = new Set();
        this.failing.set(event.runId, set);
        this.order.push(event.runId);
        if (this.order.length > this.maxRuns) {
          const oldest = this.order.shift();
          if (oldest !== undefined) this.failing.delete(oldest);
        }
      }
      set.add(event.vendor);
    } else if (event.outcome === "ok") {
      this.failing.get(event.runId)?.delete(event.vendor);
    }
  }

  /** True unless the vendor's last call in the run failed. */
  usable(runId: string, vendor: Vendor): boolean {
    return !this.failing.get(runId)?.has(vendor);
  }
}

/** Applies a project's override to the global ceilings. */
export function mergeCeilings(global: Ceilings, override: CeilingsOverride | undefined): Ceilings {
  return {
    claude: override?.claude ?? global.claude,
    codex: override?.codex ?? global.codex,
    copilot: override?.copilot ?? global.copilot,
  };
}

export class Scheduler {
  private readonly cache = new Map<string, LeaseResponse>();
  /** Moves announced per run, newest run last; bounded like `VendorHealth`. */
  private readonly announced = new Map<string, Set<string>>();

  constructor(private readonly opts: SchedulerOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** A cached answer, or `undefined` when there is none or its time has passed. */
  private cached(key: string): LeaseResponse | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    const until =
      hit.decision === "granted"
        ? hit.expiresAt
        : hit.decision === "pause"
          ? hit.resumeAt
          : undefined;
    if (until !== undefined && Date.parse(until) <= this.now().getTime()) {
      // A run that resumed from a checkpoint can repeat a lease id; it gets
      // a fresh answer against current usage, not a stale grant or pause.
      this.cache.delete(key);
      return undefined;
    }
    return hit;
  }

  /**
   * Answers a lease request. A repeated `leaseId` from one engine gets the
   * same answer until the answer's `expiresAt` or `resumeAt` passes.
   */
  async decide(engineKey: string, projectId: string, req: LeaseRequest): Promise<LeaseResponse> {
    const key = `${engineKey}\u0000${req.leaseId}`;
    const cached = this.cached(key);
    if (cached) return cached;
    const ceilings = mergeCeilings(
      this.opts.settings().ceilings,
      await this.opts.projectCeilings(projectId),
    );
    // Another call may have answered the same lease while this one waited.
    const raced = this.cached(key);
    if (raced) return raced;
    const response = this.compute(req, ceilings);
    this.cache.set(key, response);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return response;
  }

  /** Drops the cached answers for one engine, such as after its stream id changes. */
  forget(engineKey: string): void {
    const prefix = `${engineKey}\u0000`;
    for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key);
  }

  private compute(req: LeaseRequest, ceilings: Ceilings): LeaseResponse {
    const now = this.now();
    const usage = this.opts.usage;
    const requested = usage.isOver(req.vendor, ceilings);
    if (!requested.over) return this.grant(req, req.vendor, now);

    if (req.role === "fixer") {
      return {
        decision: "pause",
        leaseId: req.leaseId,
        resumeAt:
          requested.resetAt ?? new Date(now.getTime() + UNKNOWN_RESET_PAUSE_MS).toISOString(),
        reason: `${req.vendor} is over its ceiling and the ${req.role} role stays with it.`,
      };
    }

    const order = this.opts.fallbackOrder ?? DEFAULT_FALLBACK_ORDER;
    const start = order.indexOf(req.vendor);
    const capable = order
      .map((_, i) => order[(start + 1 + i) % order.length] as Vendor)
      .filter((v) => v !== req.vendor && VENDOR_ROLES[v].includes(req.role));
    // A vendor that is failing in this run would only fail the call; its
    // window resetting doesn't make it work, so its reset doesn't count.
    const usable = this.opts.usable ?? (() => true);
    const candidates = capable.filter((v) => usable(req.runId, v));
    const failing = capable.filter((v) => !candidates.includes(v));
    const resets: string[] = requested.resetAt ? [requested.resetAt] : [];
    for (const vendor of candidates) {
      const state = usage.isOver(vendor, ceilings);
      if (!state.over) {
        this.announce(req, vendor);
        return this.grant(req, vendor, now);
      }
      if (state.resetAt) resets.push(state.resetAt);
    }

    const reason =
      failing.length > 0
        ? `${req.vendor} is over its ceiling, and no other vendor can take the ${req.role} role: ${failing.join(" and ")} failed earlier in this run${candidates.length > 0 ? `, and ${candidates.join(" and ")} ${candidates.length === 1 ? "is" : "are"} over the ceiling too` : ""}.`
        : `Every vendor that can take the ${req.role} role is over its ceiling.`;
    if (resets.length === 0) {
      return { decision: "deny", leaseId: req.leaseId, reason, action: "pause" };
    }
    const earliest = resets.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
    return { decision: "pause", leaseId: req.leaseId, resumeAt: earliest, reason };
  }

  private grant(req: LeaseRequest, vendor: Vendor, now: Date): LeaseResponse {
    return {
      decision: "granted",
      leaseId: req.leaseId,
      vendor,
      redirectedFrom: vendor === req.vendor ? null : req.vendor,
      expiresAt: new Date(
        now.getTime() + (this.opts.grantTtlMs ?? DEFAULT_GRANT_TTL_MS),
      ).toISOString(),
    };
  }

  /** Emits `role.reassigned` once per run, role, and move. */
  private announce(req: LeaseRequest, to: Vendor): void {
    if (req.role === "sweeper") return;
    const key = `${req.role}|${req.vendor}|${to}`;
    let moves = this.announced.get(req.runId);
    if (!moves) {
      moves = new Set();
      this.announced.set(req.runId, moves);
      if (this.announced.size > ANNOUNCED_RUN_LIMIT) {
        const oldest = this.announced.keys().next().value;
        if (oldest !== undefined) this.announced.delete(oldest);
      }
    }
    if (moves.has(key)) return;
    moves.add(key);
    this.opts.emit({
      type: "role.reassigned",
      runId: req.runId,
      role: req.role,
      from: [req.vendor],
      to: [to],
      reason: "ceiling",
      effectiveRound: this.opts.runRound(req.runId),
    });
  }
}
