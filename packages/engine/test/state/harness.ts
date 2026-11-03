// Builds a run on the sample repository and exposes its `RunContext`, for
// tests that drive one stage or one call at a time.
import {
  FakeClock,
  GrantingBroker,
  MemoryEventSink,
  type EngineDeps,
  type LeaseBroker,
} from "../../src/core.js";
import { ExecaRunner } from "../../src/range/exec.js";
import type { RunContext } from "../../src/state/context.js";
import { RunController } from "../../src/state/controller.js";
import { Scenario, buildSampleRepo } from "./scenario.js";
import { uniqueRunId } from "./run-ids.js";

export const nextRunId = uniqueRunId;

export interface Harness {
  repo: string;
  run: RunController;
  ctx: RunContext;
  deps: EngineDeps;
  events: MemoryEventSink;
  clock: FakeClock;
}

/** The context behind a controller. Tests only. */
export function contextOf(run: RunController): RunContext {
  return (run as unknown as { ctx: RunContext }).ctx;
}

export async function makeRun(
  options: {
    adapters?: EngineDeps["adapters"];
    broker?: LeaseBroker;
    request?: Record<string, unknown>;
    deps?: Partial<EngineDeps>;
    repo?: string;
  } = {},
): Promise<Harness> {
  const repo = options.repo ?? buildSampleRepo();
  const clock = new FakeClock();
  const events = new MemoryEventSink("engine:test", "s", clock);
  const deps: EngineDeps = {
    adapters: options.adapters ?? new Scenario().adapters(),
    broker: options.broker ?? new GrantingBroker(clock),
    events,
    runner: new ExecaRunner(),
    clock,
    container: "c",
    ...options.deps,
  };
  const run = await RunController.create(
    {
      runId: nextRunId(),
      projectId: "sample",
      repoPath: repo,
      depth: "thorough",
      ...options.request,
    },
    { projectRoot: repo },
    deps,
  );
  return { repo, run, ctx: contextOf(run), deps, events, clock };
}
