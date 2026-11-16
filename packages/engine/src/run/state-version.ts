import { RunStateSchema, type RunState } from "@aio/contracts";
import { z } from "zod";

// Entry n converts state version n + 1 to n + 2. Never remove an old step.
// Keep a saved example for every version in test/run/fixtures.
const stateAdaptations: readonly ((state: Record<string, unknown>) => Record<string, unknown>)[] =
  [];
export const CURRENT_RUN_STATE_VERSION = 1 + stateAdaptations.length;

export class NewerRunStateError extends Error {
  readonly code = "invalid_state";
  readonly stoppedState: RunState | undefined;

  constructor(
    readonly stateVersion: number,
    saved: Record<string, unknown>,
  ) {
    super(
      `This run was saved with state version ${stateVersion}; this engine supports up to version ${CURRENT_RUN_STATE_VERSION}. It stays stopped. Upgrade AI Orchestrator to resume it.`,
    );
    this.name = "NewerRunStateError";
    // A display-only view. Never save it back over the newer version's data.
    const view = RunStateSchema.safeParse({ ...saved, status: "paused", error: this.message });
    this.stoppedState = view.success ? view.data : undefined;
  }
}

/** Check the version before interpreting any fields from a newer engine. */
export function adaptRunState(saved: unknown): RunState {
  let state = z.record(z.unknown()).parse(saved);
  const version = z
    .number()
    .int()
    .positive()
    .parse(state.stateVersion === undefined ? 1 : state.stateVersion);
  if (version > CURRENT_RUN_STATE_VERSION) throw new NewerRunStateError(version, state);
  for (let step = version - 1; step < stateAdaptations.length; step++) {
    state = { ...stateAdaptations[step]!(state), stateVersion: step + 2 };
  }
  return RunStateSchema.parse(state);
}
