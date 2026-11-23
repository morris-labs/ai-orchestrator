// The shared agent-call core, driven by a caller that isn't a review run.
import { describe, expect, it } from "vitest";
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
  RunCancelled,
  basicRouting,
  newCallLedger,
  type AgentCallHost,
  type AgentCallSpec,
  type AgentOutcome,
  type CallCache,
} from "../../src/calls/index.js";
import { ExecaRunner } from "../../src/range/exec.js";
import { uniqueRunId } from "../state/run-ids.js";
import { buildSampleRepo } from "../state/scenario.js";

class LimitError extends Error {}

interface Answer {
  text: string;
}

/** An adapter that answers `fix` calls and counts them. */
function answering(vendor: Vendor, text = `from ${vendor}`): VendorAdapter & { calls: number } {
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
function limited(vendor: Vendor): VendorAdapter {
  return {
    vendor,
    fix: () => Promise.reject(new LimitError("usage limit")),
    detectLimit: (e: unknown) =>
      e instanceof LimitError ? { resetAt: null, message: "usage limit" } : null,
  } as unknown as VendorAdapter;
}

/** An adapter whose call never ends until it is aborted. */
function hanging(vendor: Vendor): VendorAdapter {
  return {
    vendor,
    fix: (request: { signal?: AbortSignal }) =>
      new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    detectLimit: () => null,
  } as unknown as VendorAdapter;
}

class MemoryCache implements CallCache {
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
function makeCaller(adapters: Partial<Record<Vendor, VendorAdapter>>, cache = new MemoryCache()) {
  const clock = new FakeClock();
  const events = new MemoryEventSink("engine:test", "s", clock);
  const broker = new GrantingBroker(clock);
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
  };
  const calls = new AgentCalls(host, {
    adapters,
    broker,
    runner: new ExecaRunner(),
    clock,
  });
  return { id, calls, broker, emitted, statuses, cache };
}

function spec(repoPath: string, overrides: Partial<AgentCallSpec> = {}): AgentCallSpec {
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

describe("AgentCalls for a caller that isn't a review run", () => {
  it("makes a leased call and reports its events under the caller's id", async () => {
    const repo = buildSampleRepo();
    const { id, calls, broker, emitted } = makeCaller({ codex: answering("codex") });

    const outcome = await calls.call<Answer>(spec(repo));

    expect(outcome.output).toEqual({ text: "from codex" });
    expect(outcome.vendor).toBe("codex");
    expect(broker.requests).toHaveLength(1);
    expect(broker.requests[0]?.leaseId).toBe(`${id}-L1`);
    expect(broker.settled.map((s) => s.leaseId)).toEqual([`${id}-L1`]);
    expect(emitted.map((e) => e.type)).toEqual([
      "agent.started",
      "agent.finished",
      "lease.settled",
    ]);
    const started = emitted[0] as Extract<EventDraft, { type: "agent.started" }>;
    expect(started).toMatchObject({ runId: id, agentId: `${id}-A1`, role: "fixer" });
    const finished = emitted[1] as Extract<EventDraft, { type: "agent.finished" }>;
    expect(finished).toMatchObject({ outcome: "ok", model: "codex-model" });
  });

  it("returns a finished call from the cache instead of calling again", async () => {
    const repo = buildSampleRepo();
    const codex = answering("codex");
    const first = makeCaller({ codex });
    await first.calls.call<Answer>(spec(repo));

    // A restarted caller with the same cache repeats nothing.
    const again = makeCaller({ codex }, first.cache);
    const outcome = await again.calls.call<Answer>(spec(repo));

    expect(outcome.output).toEqual({ text: "from codex" });
    expect(codex.calls).toBe(1);
    expect(again.broker.requests).toHaveLength(0);
  });

  it("moves a call to the next vendor when one reports a limit", async () => {
    const repo = buildSampleRepo();
    const { calls } = makeCaller({ codex: limited("codex"), claude: answering("claude") });

    const outcome = await calls.call<Answer>(spec(repo));

    expect(outcome.vendor).toBe("claude");
    expect(calls.limitOf("codex")).toMatchObject({ until: null, message: "usage limit" });
  });

  it("keeps a call that may not move and asks a person", async () => {
    const repo = buildSampleRepo();
    const { calls } = makeCaller({ codex: limited("codex"), claude: answering("claude") });

    await expect(calls.call<Answer>(spec(repo, { allowFallback: false }))).rejects.toThrow(
      /no reset time/,
    );
  });

  it("stops a call under way when the caller cancels", async () => {
    const repo = buildSampleRepo();
    const { calls } = makeCaller({ codex: hanging("codex") });

    const pending = calls.call<Answer>(spec(repo));
    setTimeout(() => calls.requestCancel(), 10);

    await expect(pending).rejects.toBeInstanceOf(RunCancelled);
    expect(calls.cancelled).toBe(true);
  });

  it("holds calls while paused and lets them start after a resume", async () => {
    const repo = buildSampleRepo();
    const codex = answering("codex");
    const { calls, statuses } = makeCaller({ codex });

    calls.requestPause();
    const pending = calls.call<Answer>(spec(repo));
    await new Promise((r) => setTimeout(r, 20));
    expect(codex.calls).toBe(0);
    calls.requestResume();
    await pending;

    expect(codex.calls).toBe(1);
    expect(statuses).toEqual(["paused", "running"]);
  });
});
