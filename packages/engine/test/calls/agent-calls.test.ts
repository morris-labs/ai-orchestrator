// The shared agent-call core, driven by a caller that isn't a review run.
import { describe, expect, it } from "vitest";
import type { LeaseRequest } from "@aio/contracts";
import { GrantingBroker, type EventDraft } from "../../src/core.js";
import { RunCancelled, basicRouting } from "../../src/calls/index.js";
import { buildSampleRepo } from "../state/scenario.js";
import { uniqueRunId } from "../state/run-ids.js";
import { answering, hanging, limited, makeCaller, spec, type Answer } from "./caller.js";

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

  it("settles the lease when the granted vendor has no adapter", async () => {
    const repo = buildSampleRepo();
    const { id, calls, broker } = makeCaller({});

    await expect(calls.call<Answer>(spec(repo))).rejects.toThrow(/No adapter/);

    expect(broker.settled.map((s) => s.leaseId)).toEqual([`${id}-L1`]);
  });

  it("settles the lease once when saving the run before the call fails", async () => {
    const repo = buildSampleRepo();
    let saves = 0;
    const { id, calls, broker, emitted } = makeCaller(
      { codex: answering("codex") },
      undefined,
      undefined,
      {
        // The first save comes before the lease request, the second after the grant.
        persist: () => (++saves > 1 ? Promise.reject(new Error("disk full")) : Promise.resolve()),
      },
    );

    await expect(calls.call<Answer>(spec(repo))).rejects.toThrow(/disk full/);

    expect(broker.settled.map((s) => s.leaseId)).toEqual([`${id}-L1`]);
    expect(emitted.filter((e) => e.type === "lease.settled")).toHaveLength(1);
  });

  it("settles the lease with the call's usage when an event after the call fails", async () => {
    const repo = buildSampleRepo();
    let failed = false;
    const { id, calls, broker } = makeCaller({ codex: answering("codex") }, undefined, undefined, {
      emit: (draft) => {
        if (draft.type === "agent.finished" && !failed) {
          failed = true;
          return Promise.reject(new Error("event log closed"));
        }
        return Promise.resolve();
      },
    });

    await expect(calls.call<Answer>(spec(repo))).rejects.toThrow(/event log closed/);

    expect(broker.settled).toHaveLength(1);
    expect(broker.settled[0]).toMatchObject({
      leaseId: `${id}-L1`,
      actual: { tokens: { in: 10, out: 5 } },
    });
  });

  it("settles a redirected lease when recording the move fails", async () => {
    const repo = buildSampleRepo();
    class Redirecting extends GrantingBroker {
      override async acquire(request: LeaseRequest) {
        const granted = await super.acquire(request);
        return { ...granted, vendor: "claude" as const, redirectedFrom: request.vendor };
      }
    }
    const routing = basicRouting({ fallbackOrder: ["codex", "claude"], timeoutMs: 60_000 });
    const { id, calls, broker } = makeCaller(
      { codex: answering("codex"), claude: answering("claude") },
      undefined,
      (clock) => new Redirecting(clock),
      { routing: { ...routing, moved: () => Promise.reject(new Error("routing file locked")) } },
    );

    await expect(calls.call<Answer>(spec(repo))).rejects.toThrow(/routing file locked/);

    expect(broker.settled.map((s) => s.leaseId)).toEqual([`${id}-L1`]);
  });

  it("names the build, seat, and step on a build call's lease and events", async () => {
    const repo = buildSampleRepo();
    const buildId = uniqueRunId();
    const { id, calls, broker, emitted } = makeCaller(
      { codex: answering("codex") },
      undefined,
      undefined,
      {
        owner: { runId: null, buildId },
      },
    );

    await calls.call<Answer>(spec(repo, { seat: "developer", step: "tasks" }));

    const owner = { runId: null, buildId, seat: "developer", step: "tasks" };
    expect(broker.requests[0]).toMatchObject({ leaseId: `${id}-L1`, ...owner });
    expect(emitted.map((e) => e.type)).toEqual([
      "agent.started",
      "agent.finished",
      "lease.settled",
    ]);
    for (const event of emitted) expect(event).toMatchObject(owner);
  });

  it("leaves the build fields out of a review run's lease and events", async () => {
    const repo = buildSampleRepo();
    const { id, calls, broker, emitted } = makeCaller({ codex: answering("codex") });

    await calls.call<Answer>(spec(repo));

    for (const record of [broker.requests[0], ...emitted]) {
      expect(record).toMatchObject({ runId: id });
      for (const key of ["buildId", "seat", "step"]) expect(record).not.toHaveProperty(key);
    }
  });

  it("passes a named session to the adapter, for a write call as for a continuation", async () => {
    const repo = buildSampleRepo();
    const adapter = answering("codex");
    const seen: (string | undefined)[] = [];
    const fix = adapter.fix.bind(adapter);
    adapter.fix = (request) => {
      seen.push((request as { sessionId?: string }).sessionId);
      return fix(request);
    };
    const { calls } = makeCaller({ codex: adapter });
    const base = spec(repo);

    await calls.call<Answer>({ ...base, request: { ...base.request, sessionId: "s-1" } });
    await calls.call<Answer>({ ...base, key: "task-2" });

    expect(seen).toEqual(["s-1", undefined]);
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
