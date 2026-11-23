// A caller of the shared agent-call core that isn't a review run, with
// adapters that answer, hit a limit, or hang.
import type { Vendor } from "@aio/contracts";
import {
  FakeClock,
  GrantingBroker,
  MemoryEventSink,
  type AdapterResult,
  type EventDraft,
  type VendorAdapter,
} from "../../src/core.js";
import {
  AgentCalls,
  basicRouting,
  newCallLedger,
  type AgentCallHost,
  type AgentCallSpec,
  type AgentOutcome,
  type CallCache,
} from "../../src/calls/index.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { uniqueRunId } from "../state/run-ids.js";

export class LimitError extends Error {}

export interface Answer {
  text: string;
}

/** An adapter that answers `fix` calls and counts them. */
export function answering(
  vendor: Vendor,
  text = `from ${vendor}`,
): VendorAdapter & { calls: number } {
  const adapter = {
    vendor,
    calls: 0,
    fix: (): Promise<AdapterResult<Answer>> => {
      adapter.calls += 1;
      return Promise.resolve({
        output: { text },
        model: `${vendor}-model`,
        sessionId: "s-1",
        tokens: { in: 10, out: 5 },
        usage: [],
        premiumRequests: 0,
        costEstimate: 0.01,
      });
    },
    detectLimit: () => null,
  };
  return adapter as unknown as VendorAdapter & { calls: number };
}

/** An adapter whose every call hits a usage limit with no reset time. */
export function limited(vendor: Vendor): VendorAdapter {
  return {
    vendor,
    fix: () => Promise.reject(new LimitError("usage limit")),
    detectLimit: (e: unknown) =>
      e instanceof LimitError ? { resetAt: null, message: "usage limit" } : null,
  } as unknown as VendorAdapter;
}

/**
 * An adapter whose first call hits a usage limit that resets at `resetAt`;
 * every later call answers.
 */
export function limitedUntil(vendor: Vendor, resetAt: string): VendorAdapter & { calls: number } {
  const inner = answering(vendor);
  const adapter = {
    ...inner,
    calls: 0,
    fix: (...args: unknown[]) => {
      adapter.calls += 1;
      if (adapter.calls === 1) return Promise.reject(new LimitError("usage limit"));
      return (inner.fix as (...a: unknown[]) => Promise<unknown>)(...args);
    },
    detectLimit: (e: unknown) =>
      e instanceof LimitError ? { resetAt, message: "usage limit", kind: "usage_limit" } : null,
  };
  return adapter as unknown as VendorAdapter & { calls: number };
}

/**
 * An adapter that answers `fix` calls only when the test calls `release()`.
 * `started` resolves when the first call begins.
 */
export function gated(vendor: Vendor): VendorAdapter & {
  calls: number;
  started: Promise<void>;
  release: () => void;
} {
  let release = (): void => undefined;
  let begin = (): void => undefined;
  const opened = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (begin = resolve));
  const inner = answering(vendor);
  const adapter = {
    ...inner,
    get calls() {
      return inner.calls;
    },
    started,
    release: () => release(),
    fix: async (...args: unknown[]) => {
      begin();
      await opened;
      return (inner.fix as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  };
  return adapter as unknown as VendorAdapter & {
    calls: number;
    started: Promise<void>;
    release: () => void;
  };
}

/** An adapter whose call never ends until it is aborted. */
export function hanging(vendor: Vendor): VendorAdapter {
  return {
    vendor,
    fix: (request: { signal?: AbortSignal }) =>
      new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    detectLimit: () => null,
  } as unknown as VendorAdapter;
}

export class MemoryCache implements CallCache {
  readonly saved = new Map<string, unknown>();
  read<T>(key: string): Promise<AgentOutcome<T> | null> {
    return Promise.resolve((this.saved.get(key) as AgentOutcome<T> | undefined) ?? null);
  }
  write<T>(key: string, outcome: AgentOutcome<T>): Promise<void> {
    this.saved.set(key, outcome);
    return Promise.resolve();
  }
}

/** A minimal caller: a build-like task runner with its own status and cache. */
export function makeCaller(
  adapters: Partial<Record<Vendor, VendorAdapter>>,
  cache = new MemoryCache(),
  makeBroker: (clock: FakeClock) => GrantingBroker = (clock) => new GrantingBroker(clock),
  extra: Partial<AgentCallHost> = {},
) {
  const clock = new FakeClock();
  const events = new MemoryEventSink("engine:test", "s", clock);
  const broker = makeBroker(clock);
  const emitted: EventDraft[] = [];
  const statuses: string[] = [];
  let paused: string | undefined;
  let isPaused = false;
  const id = uniqueRunId();
  const host: AgentCallHost = {
    id,
    round: () => 1,
    ledger: (() => {
      const ledger = newCallLedger();
      return () => ledger;
    })(),
    persist: () => Promise.resolve(),
    emit: (draft) => {
      emitted.push(draft);
      events.emit(draft);
      return Promise.resolve();
    },
    status: {
      paused: () => isPaused,
      pausedUntil: () => paused,
      pause: (until) => {
        isPaused = true;
        paused = until;
        statuses.push(`paused${until ? ` until ${until}` : ""}`);
        return Promise.resolve();
      },
      resume: () => {
        isPaused = false;
        paused = undefined;
        statuses.push("running");
        return Promise.resolve();
      },
    },
    cache,
    routing: basicRouting({ fallbackOrder: ["codex", "claude", "copilot"], timeoutMs: 60_000 }),
    treeGuard: { ignore: [] },
    ...extra,
  };
  const calls = new AgentCalls(host, {
    adapters,
    broker,
    runner: new ExecaRunner(),
    clock,
  });
  return { id, calls, broker, emitted, statuses, cache };
}

export function spec(repoPath: string, overrides: Partial<AgentCallSpec> = {}): AgentCallSpec {
  return {
    key: "task-1",
    role: "fixer",
    vendor: "codex",
    method: "fix",
    request: { prompt: "Write the code.", repoPath, toolPolicy: "write" },
    groupId: null,
    estimateTokens: 100,
    ...overrides,
  };
}
