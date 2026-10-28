// The lease scheduler. Before each model call an engine asks for a lease;
// the scheduler grants it, moves the role to another vendor under its
// ceiling, or tells the run to pause until a window resets. The rules follow
// "Usage tracking and rebalancing" in the review pipeline design: review and
// disprove roles fall back to the next vendor, and the fixer stays with
// Claude, so a Claude over its ceiling pauses the run.
import type {
  AgentBoxEvent,
  AgentRole,
  Ceilings,
  CeilingsOverride,
  GlobalSettings,
  LeaseRequest,
  LeaseResponse,
  Vendor,
} from "@agentbox/contracts";
import type { EventInput } from "../api/core-interface.js";
import type { UsageService } from "../usage/usage-service.js";

/** The roles each vendor can take. */
export const VENDOR_ROLES: Record<Vendor, readonly AgentRole[]> = {
  claude: ["reviewer", "disprover", "fixer", "sweeper"],
  codex: ["reviewer", "disprover", "confirmer", "sweeper"],
  copilot: ["reviewer", "sweeper"],
};

export const DEFAULT_FALLBACK_ORDER: readonly Vendor[] = ["codex", "copilot", "claude"];
export const DEFAULT_GRANT_TTL_MS = 10 * 60 * 1000;
/** How long a run pauses when the vendor's reset time is unknown. */
export const UNKNOWN_RESET_PAUSE_MS = 15 * 60 * 1000;
const CACHE_LIMIT = 10_000;

export interface SchedulerOptions {
  usage: UsageService;
  settings: () => GlobalSettings;
  projectCeilings: (projectId: string) => Promise<CeilingsOverride | undefined>;
  /** The run's current round, for `role.reassigned`. */
  runRound: (runId: string) => number;
  emit: (event: EventInput) => AgentBoxEvent;
  now?: () => Date;
  grantTtlMs?: number;
  fallbackOrder?: Vendor[];
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
  private readonly announced = new Set<string>();

  constructor(private readonly opts: SchedulerOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** Answers a lease request. A repeated `leaseId` from one engine gets the same answer. */
  async decide(engineKey: string, projectId: string, req: LeaseRequest): Promise<LeaseResponse> {
    const key = `${engineKey}\u0000${req.leaseId}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const ceilings = mergeCeilings(
      this.opts.settings().ceilings,
      await this.opts.projectCeilings(projectId),
    );
    // Another call may have answered the same lease while this one waited.
    const raced = this.cache.get(key);
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
        reason: `${req.vendor} is over its ceiling and the fixer role stays with it.`,
      };
    }

    const order = this.opts.fallbackOrder ?? DEFAULT_FALLBACK_ORDER;
    const start = order.indexOf(req.vendor);
    const candidates = order
      .map((_, i) => order[(start + 1 + i) % order.length] as Vendor)
      .filter((v) => v !== req.vendor && VENDOR_ROLES[v].includes(req.role));
    const resets: string[] = requested.resetAt ? [requested.resetAt] : [];
    for (const vendor of candidates) {
      const state = usage.isOver(vendor, ceilings);
      if (!state.over) {
        this.announce(req, vendor);
        return this.grant(req, vendor, now);
      }
      if (state.resetAt) resets.push(state.resetAt);
    }

    if (resets.length === 0) {
      return {
        decision: "deny",
        leaseId: req.leaseId,
        reason: `Every vendor that can take the ${req.role} role is over its ceiling.`,
        action: "pause",
      };
    }
    const earliest = resets.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
    return {
      decision: "pause",
      leaseId: req.leaseId,
      resumeAt: earliest,
      reason: `Every vendor that can take the ${req.role} role is over its ceiling.`,
    };
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
    const key = `${req.runId}|${req.role}|${req.vendor}|${to}`;
    if (this.announced.has(key)) return;
    this.announced.add(key);
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
